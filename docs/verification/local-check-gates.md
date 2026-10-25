# Local check priority and CPU admission

The incident report described local check services competing with message
delivery after the remote check host retired. This change puts CPU and I/O
weight 10 on each local check service and prevents the ten-minute queue bound
from overriding measured pressure for heavy checks. Stage and workflow tickets
still start at their own bound when a check held by pressure is ahead of them.
A live owner-relay stop that cannot be confirmed now backs off to one retry a
minute.

## Launch and admission paths

| Producer | Consumer and effect |
| --- | --- |
| `scripts/gate-slot.sh`: normal command, validated nested slot, pre-push parent, CPU-placement opt-out | `scripts/owned-runner.ts` uses `gateServiceProperties` for every transient service |
| Signal-domain gate with a user manager | The same service properties apply before namespace entry |
| Direct `owned-runner.ts` invocation | The same properties apply without a slice override |
| CPU-placement enabled | Existing aggregate work-slice weight 100 and quotas remain; the check service gets CPU/I/O weight 10 |
| No reachable user manager | Existing bounded portable/namespace fallback; no transient unit exists |
| `scripts/cpu-admission.ts --wait` and `--claim` | Both require a permissive sample, including after the queue bound and helper restart |
| Stage/workflow queue callers | Ten-minute fairness bound remains; once it runs out, a stage or workflow ticket passes heavy checks still waiting for low pressure |
| `scripts/build-gate.ts` | Bundles the new imports into the shipped admission and owned-runner entries |

PSI uses the existing 30% hold threshold, 20% release threshold and ten-second
release window. Sampling yields the event loop. Missing PSI falls back to the
one-minute load divided by online CPUs, requiring less than 0.75 per CPU.
Unreadable metrics keep the command waiting. The existing explicit pressure-off
setting remains available. Slot claims, queue order and admission spacing still
apply. A stable wait reason is printed once while that reason remains current.

## Serving priority observation

A read-only check on 2026-10-25 at 03:01 (UTC+3) read the user manager's units
and cgroup files. The serving unit runs in `delegatus.slice` with configured and
effective CPU weight 1000. The runtime host runs inside that same unit; there
is no separate runtime-host user unit. Its sibling `delegatus-agents.slice`
has weight 100, and the check services inside `delegatus-agents-work.slice`
each have weight 10. Under contention the serving unit therefore receives about
1000/1100 of the CPU its slice receives, whatever the number of checks. The
user manager delegates only the `cpu`, `memory` and `pids` controllers, so
`IOWeight=10` is recorded on each check unit but the kernel does not enforce
it there. An earlier observation of the serving unit at weight 100 under
`app.slice` no longer matches the installation. This stage changed no serving
unit, controller, relay queue record or serving process.
The real-manager test verifies the produced transient-unit properties.

## CPU queue order under pressure

A heavy check waits for a permissive sample at its readiness check and again at
its claim, even after its own ten-minute bound. Stage and workflow tickets
share the machine queue (`src/lib/runtime/cpuAdmissionScope.ts`), so a check
held at the head by pressure kept every stage behind it waiting: with
sustained pressure, a stage queued one second after a check was still second
in line after an hour. Each check now records on its ticket that it needs low
pressure (`low_pressure`). A ticket that does not need it, and whose own
ten-minute bound has run out, no longer counts those tickets ahead of it
(`CpuAdmissionQueue.check` in `src/lib/runtime/cpuAdmission.ts`). Checks keep
FIFO among themselves and behind older stages, and spacing still separates
every start. A helper from an older release leaves the column at 0, which is
the earlier behaviour for its tickets.

## Repeating owner-stop warning

Measured from `journalctl --user -u delegatus.service`, read on 2026-10-25
between 2026-10-23T00:00 and 2026-10-25T03:00 (UTC+3). Every matching line
reads "Owner relay stop remains pending; durable custody retained", which only
`confirmOwnerStop` in `src/lib/externalRelay/ownerRun.ts` writes.

| Viewer process | Lines | First and last line | Gap between lines |
| --- | --- | --- | --- |
| Earlier process | 16,214 | 2026-10-23 01:40 to 2026-10-24 23:14; 16,207 of them after 2026-10-24 11:13 | median 2 s, 90th percentile 5 s; up to 3 in one second; peak hour 22:00 with 2,927 |
| Current process | 444 | 2026-10-24 23:17 to 2026-10-25 02:59 | pairs one second apart, once a minute: 222 minutes × 2 rows |

Two paths write the line:

1. **Live stop retry.** When an owner turn passes its execution limit or its
   admission deadline, `runOwnerAgent` cancels it, and `applyStop` calls
   `confirmOwnerStop` for that turn's custody. Unconfirmed, it re-armed itself
   with a fixed `setTimeout(applyStop, stopRetryMs ?? 1000)` for as long as
   that Viewer lived. One round is three control attempts 250 ms apart plus the
   one-second timer, which matches the 2-second median gap. The poller's sweep
   skips these runs while a live callback holds them. The earlier process
   logged five failed owner turns that day (two past the execution limit, three
   past the admission deadline), and the rate rose with the number of turns
   still retrying. This path wrote 16,207 of the lines.
2. **Minute sweep.** After a restart no live callback holds a run, so
   `sweepExternalRelayOrphans` in `src/lib/externalRelay/poller.ts` calls
   `confirmOwnerStop` once a minute for each retained row. Two rows remain,
   which gives the current process's two lines per minute.

**Fix in this change.** The live retry now backs off: `ownerStopRetryDelayMs`
doubles the base delay after each unconfirmed round, up to 60 times the base.
In production that is 1, 2, 4, 8, 16 and 32 seconds, then one minute, the
sweep's cadence. A turn still retrying for a day now writes about 1,440
lines; the fixed retry wrote 16,207 in under twelve hours. The test "an unconfirmed live
stop backs off to its cap" in `src/lib/externalRelay/ownerTier.test.ts` checks
the delay sequence. It also runs a real owner turn whose stop always fails and
counts its warnings: with a 2 ms base it writes at most 13 in 600 ms, each gap
at least its scheduled delay. With the fixed retry it wrote 64.

**What never completes.** Both retained rows were read from the relay run
ledger, read-only. Both have a known conversation, a completed admission, a
cutoff, and capacity released as `stop_unconfirmed` after ten minutes. One is a
first turn stopped at its execution limit; the other is a continuation stopped
at its admission deadline. Neither has `confirmed`. The conversations' own
transcripts show both executors stopped. The first was interrupted 7 seconds
after its cutoff, and the second has had no turn since before its cutoff.
Termination still cannot be confirmed, because `confirmOwnerStop` accepts only
three proofs: a successful stop call, an observation of `ended` or
`host-died`, or the no-execution proof. The production stop port throws for a
first turn whose first prompt never settles (`OwnerPromptCleanupPending`) and
for a continuation the conversation action refuses. Which of these holds for
each row is inferred; confirming it means calling the stop port against the
live installation, which this stage did not do. Accepting an idle or
interrupted conversation as proof of termination changes the relay's custody
rule. That needs its own relay change, with restart and race coverage, so it
is left out of this one. Open pull request #3332 is changing the same file.

## Verification before publication repair

Checks run serially through the prescribed installed gate wrapper in a scratch
export, with private HOME, XDG directories, TMPDIR, state and test queue roots.
Checks used the installed wrapper from release `19bbd6d7c281`, Bun 1.4.0, and
the pinned source base `97bdb94e`, on 2026-10-24. At the original acceptance, source/export comparison
passed for all twelve changed executable files. Their SHA-256, hashing sorted
repository-relative path, NUL and file bytes, is
`83ee7b507476d86b1c4699b1472831a0e825c4a22c9bfd4f8413ef993a09c822`.
The report and design documentation are excluded from that executable digest.

The following are the commands inside the wrapper. Exit sequences show each
invocation in order. The first pressure-test attempt lacked installed
dependencies and failed before assertions; the frozen install corrected that
export setup. The first typecheck found an overly broad environment parameter
type, corrected before the final typecheck. The final test set below totals
100 passing cases and two clean skips, excluding diagnostic baseline runs.

| Command | Exit code(s) | Final result |
| --- | --- | --- |
| `bun install --frozen-lockfile` | 0 | Pinned dependencies installed in scratch |
| `bun test src/lib/runtime/gateCpuPressure.test.ts` | 1, 0, 0 | 4 pass; first run had missing dependencies |
| `bun test src/lib/runtime/cpuAdmission.test.ts` | 1, 0 | 40 pass |
| `bun test src/lib/runtime/cpuPressure.test.ts` | 0 | 8 pass |
| `bun test src/lib/runtime/cpuPlacement.test.ts` | 0 | 7 pass |
| `bun test scripts/gate-properties.test.ts` | 0, 0, 0 | 2 pass against the real user manager, including command exit 37 |
| `bun test scripts/gate-slot.test.ts` | 1, 0 | 15 pass |
| `bun test scripts/gate-slot.queue.test.ts` | 1, 0 | 10 pass |
| `bun test bin/install-cpu-placement.test.ts` | 0 | 5 pass; serving weight 1000 retained |
| `bun test src/lib/externalRelay/ownerStop.test.ts` | 1 | 23 pass, one pre-existing failure described below |
| `bun test src/lib/externalRelay/ownerStop.test.ts -t 'unreadable ended turn\|retired continuation\|missing conversation\|missing current entry\|restarted production sweeper'` | 0 | 7 evidence cases pass |
| `env DBUS_SESSION_BUS_ADDRESS=unix:path="$TMPDIR/absent-bus" bun test scripts/gate-properties.test.ts` | 0, 0 | 2 clean skips |
| `bun test scripts/owned-runner.integration.test.ts -t 'actual gate runner (exit\|timeout)'` | 0 | 2 pass; real service exit/deadline cleanup preserves bystanders |
| `node node_modules/typescript/bin/tsc --noEmit --incremental false` | 2 | New environment-parameter typing error identified |
| `node node_modules/typescript/bin/tsc --noEmit --incremental --tsBuildInfoFile "$TMPDIR/verified.tsbuildinfo"` | 0, 0 | Full typecheck passes; no prior build-info file existed |
| `bun scripts/build-gate.ts` | 0, 0 | Both final shipped gate entries bundle |
| `bun "$TMPDIR/bundle-smoke.ts"` | 0, 0 | Bundled admission claims a private queue; bundled owned runner executes `/bin/true` |
| `bash -n scripts/gate-slot.sh` | 0 | Shell syntax passes |
| `git diff --check` | 0 on every invocation | No whitespace errors |

ESLint ran twice over all changed TypeScript files, both exits 0, using this
command (argument order differed). After the probe safety correction,
`node node_modules/eslint/bin/eslint.js scripts/gate-properties.test.ts`
also exited 0:

```sh
node node_modules/eslint/bin/eslint.js \
  scripts/cpu-admission.ts scripts/owned-runner.ts \
  scripts/gate-properties.test.ts scripts/gate-slot.test.ts \
  scripts/gate-slot.queue.test.ts src/lib/runtime/cpuAdmission.ts \
  src/lib/runtime/cpuAdmission.test.ts src/lib/runtime/cpuPlacement.ts \
  src/lib/runtime/cpuPressure.test.ts src/lib/runtime/gateCpuPressure.ts \
  src/lib/runtime/gateCpuPressure.test.ts
```

The initial serial wrapper exited 1 because its diagnostic runs included the
failures above; both corrected serial wrappers exited 0. All tests and probes
used private queue and state roots. No workflow file changed.

### Paired failures and regression proof

Before changing the touched fixtures, the same isolated base reproduced the
publication binding/PID failure and both queue-fixture failures. The binding
fixture now uses local identities consistently; the native-PID emulation uses
a private portable runner; a nested gate selecting another pool drops its old
lease. Both old and new implementations retain their production guards.

| Command and tree | Exit | Observation |
| --- | --- | --- |
| Base: `bun test src/lib/runtime/cpuAdmission.test.ts -t 'the gate helper inherits a publication'` | 1 | Same position 1 versus expected 2 as the initial branch run |
| Base: `bun test scripts/gate-slot.test.ts -t 'pressure that rises'` | 0 | Confirms the branch needed its new measured-pressure log assertion |
| Base: `bun test scripts/gate-slot.queue.test.ts -t 'a shell.s native owner mapping\|the owned runner keeps a nested'` | 1 | Same two readiness-barrier failures as the initial branch run |
| Base: `bun test src/lib/externalRelay/ownerStop.test.ts -t 'completed cleanup stays with a live foreign owner'` | 1 | Same retained-row assertion at line 215; relay source and tests remain unchanged |
| Base implementation with the new detector: `bun test src/lib/runtime/cpuAdmission.test.ts -t 'heavy gate readiness and claims'` | 1 | Old queue admits high pressure after the fairness bound; detector fails there |
| Scratch current-main compatibility: same detector command | 0 | New fence also holds with the owner cleanup from `e92a0ddde` |

The full unchanged relay-suite failure is outside the CPU-gate change and is
retained as separate evidence. The seven focused recovery cases exercise both
settlement and the missing-evidence refusal that produces the repeated warning.

The final property probe derives its unit name from a verified host process
identity: namespace-local PIDs can coincide across lanes. `RuntimeMaxSec=5s`,
`TimeoutStopSec=1s` and automatic collection bound its lifetime; it issues no
manual unit stop. The probe was rerun with and without a reachable manager.
The commits ran the launch-provided hooks: staged whitespace, privacy and
ESLint passed with exit 0. Nothing was pushed.

## Publication repair

The refusal at accepted commit `9294c1a4` named two assertions in
`src/lib/runtime/cpuPlacement.scope.test.ts`. Both still expected gate CPU
weight 100; the merger case also expected the old queue-bound log message.
The repaired cases expect weight 10 and the measured-pressure reason while
retaining their quota, memory, slice, slot and pressure-release assertions.

Merged `origin/main` at `20933a6d8`. The sole conflict in
`src/lib/runtime/cpuAdmission.ts` combines main's durable owner cleanup and
post-commit decision logging with this branch's required-pressure parameter.
Two new queue fixtures from main now supply explicit low PSI samples: empty
PSI selects the production load fallback and cannot deterministically release
a fixture on a busy machine. No check or hook was disabled.

The following checks ran serially through the prescribed gate wrapper with
private HOME, XDG directories, TMPDIR, state and queue roots. The real scope
file assumes native host process IDs, as the publisher does. Its final runs
used a bounded native user unit and the real owned runner, private state and
CPU/I/O weights 10. Native units self-expire and collect.

| Command / context | Exit | Result |
| --- | --- | --- |
| `git merge --no-commit origin/main` | 1 | One source conflict, resolved with both guards retained |
| Main, native host: `bun test src/lib/runtime/cpuPlacement.scope.test.ts -t 'gate-slot runs a gate\|a merger gate runs'` | 0 | 2 pass |
| Repaired merge, native host: `bun test src/lib/runtime/cpuPlacement.scope.test.ts` | 0 | 15 pass, including both refused cases and the tmux case |
| `bun test scripts/gate-slot.queue.test.ts` | 0 | 12 pass |
| `bun test src/lib/runtime/cpuAdmission.test.ts` | 0 | 47 pass, including main's owner recovery cases and the hard pressure fence |
| `bun test scripts/gate-properties.test.ts` | 0 | 2 pass |
| `node node_modules/typescript/bin/tsc --noEmit` | 0 | Full merged-tree typecheck |
| `node node_modules/eslint/bin/eslint.js src/lib/runtime/cpuAdmission.ts src/lib/runtime/cpuAdmission.test.ts src/lib/runtime/cpuPlacement.scope.test.ts scripts/gate-slot.queue.test.ts` | 0 | All repair/merge TypeScript changes pass |
| `git diff --cached --check` | 0 | Clean staged whitespace |

The final repaired-tree set totals 76 passing cases; the two main cases are
additional baseline observations. Initial stage-namespace scope probes exited
1 on both main and head before reaching the intended weight comparison: the
selected main cases returned 69, and the full head run also hit its tmux
fixture deadline. The bounded native-host reruns above match the publication
context and pass the complete file without weakening its assertions.

The fourteen changed executable files relative to merged main match the
verified export byte for byte. SHA-256 (sorted relative path, NUL, bytes):
`f20d9be5c133b88076c63648d74d151de82218ad4505ccf0f4c37b1a64d6ee5b`.

The merge preserves the accepted work and its ancestors. Workflow files remain
unchanged, and this repair sends no push; publication belongs to the controller.

### Cold-install fixture correction

Two full pre-push rehearsals on the merged tree exited 1 after all scope
cases passed. Both reported an unidentified between-tests error from
`scripts/local-gate.test.ts`. Direct runs of that file on the repaired tree
and merged main each exited 0 with 69 passing cases; the single-file
comparator also exited 0. A scratch diagnostic batch retained the raw error:
the cold-install fixture timed out while waiting for measured load below
0.75 per CPU, then its late cleanup opened an already removed pressure file.
The fixture had written an empty PSI file to represent an idle machine.

The fixture now writes explicit low PSI on release and cleanup, with a zero
release window for this queue-budget scenario. Its high-pressure barrier,
original-deadline assertion and owned-process cleanup assertions remain.
All PSI override callers in the gate tests were checked; the other callers
already use explicit measurements or intentionally test missing metrics.
No production threshold or admission guard changed. Diagnostic logging was
confined to scratch and removed before final verification.
