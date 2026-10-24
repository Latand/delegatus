# Local check priority and CPU admission

The incident report described local check services competing with message
delivery after the remote check host retired. This change puts CPU and I/O
weight 10 on each local check service and prevents the ten-minute queue bound
from overriding measured pressure for heavy checks.

## Launch and admission paths

| Producer | Consumer and effect |
| --- | --- |
| `scripts/gate-slot.sh`: normal command, validated nested slot, pre-push parent, CPU-placement opt-out | `scripts/owned-runner.ts` uses `gateServiceProperties` for every transient service |
| Signal-domain gate with a user manager | The same service properties apply before namespace entry |
| Direct `owned-runner.ts` invocation | The same properties apply without a slice override |
| CPU-placement enabled | Existing aggregate work-slice weight 100 and quotas remain; the check service gets CPU/I/O weight 10 |
| No reachable user manager | Existing bounded portable/namespace fallback; no transient unit exists |
| `scripts/cpu-admission.ts --wait` and `--claim` | Both require a permissive sample, including after the queue bound and helper restart |
| Stage/workflow queue callers | Existing ten-minute fairness behavior remains |
| `scripts/build-gate.ts` | Bundles the new imports into the shipped admission and owned-runner entries |

PSI uses the existing 30% hold threshold, 20% release threshold and ten-second
release window. Sampling yields the event loop. Missing PSI falls back to the
one-minute load divided by online CPUs, requiring less than 0.75 per CPU.
Unreadable metrics keep the command waiting. The existing explicit pressure-off
setting remains available. Slot claims, queue order and admission spacing still
apply. A stable wait reason is printed once while that reason remains current.

## Serving priority observation

A read-only unit-property check on 2026-10-24 found the serving unit configured
with CPU weight 1000. The production runtime-host process belongs to that same
unit; there is no separate runtime-host user unit. Its configured weight
therefore stays 1000 for both processes. The installation's kernel cgroup
reported weight 100 despite the configured 1000, and its actual cgroup was still
under `app.slice`. This is an installation discrepancy: deployment must reconcile
the configured and effective placement using the existing checkout procedure.
This stage changed no live unit, controller, relay queue record or serving process.
The real-manager test verifies the produced transient-unit properties; it does
not claim to repair controller delegation on the running installation.

## Repeating owner-stop warning

The originating report estimated about 1400 warnings over two days. A prior
recovery record from 2026-10-23 observed the warning at five consecutive minute
boundaries, an accepted completion with unreleased capacity, no live host, and
an exited original owner. Its locked manual capacity release allowed the next
sweep to retire the row. This is historical evidence; no live relay ledger was
read or modified for this change, and the two-day count was not remeasured.

The retained recovery path explains repetition:

1. `sweepExternalRelayOrphans` in `src/lib/externalRelay/poller.ts` calls
   `confirmOwnerStop` before checking accepted-completion cleanup.
2. `confirmOwnerStop` in `src/lib/externalRelay/ownerRun.ts` makes three bounded
   control/observation attempts. Without proof of ended execution it retains
   custody and logs the pending warning. After ten minutes it can release the
   target slot while preserving unconfirmed execution custody.
3. `ownerAttemptHasNoExecution` in `src/lib/externalRelay/ownerRun.ts` needs a settled
   failed spawn receipt; `ownerStopHasNoExecutionCustody` needs durable hostless
   conversation evidence. Missing registry rows cannot prove either condition.
4. The poller's minute sweep retries the retained row. Accepted completion alone
   does not confirm executor termination, so it cannot bypass this guard.

Existing successful-stop and missing-evidence cases live in
`src/lib/externalRelay/ownerStop.test.ts`. A permanent reconciliation of legacy
rows missing termination evidence requires a separate relay change, with a
durable termination receipt or another identity-bound proof and restart/race
coverage. The active relay lane also owns that area. This change retains the
termination guard and reports the separate work explicitly.

## Verification

Checks run serially through the prescribed installed gate wrapper in a scratch
export, with private HOME, XDG directories, TMPDIR, state and test queue roots.
Checks used the installed wrapper from release `19bbd6d7c281`, Bun 1.4.0, and
the pinned source base `97bdb94e`, on 2026-10-24. Final source/export comparison
passed for all twelve changed executable files. Their SHA-256, hashing sorted
repository-relative path, NUL and file bytes, is
`de57b8221215c7aa6ae3af54983874713e030e793df13aba0bdc2e5b326cbf1c`.
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
| `bun test scripts/gate-properties.test.ts` | 0, 0 | 2 pass against the real user manager, including command exit 37 |
| `bun test scripts/gate-slot.test.ts` | 1, 0 | 15 pass |
| `bun test scripts/gate-slot.queue.test.ts` | 1, 0 | 10 pass |
| `bun test bin/install-cpu-placement.test.ts` | 0 | 5 pass; serving weight 1000 retained |
| `bun test src/lib/externalRelay/ownerStop.test.ts` | 1 | 23 pass, one pre-existing failure described below |
| `bun test src/lib/externalRelay/ownerStop.test.ts -t 'unreadable ended turn\|retired continuation\|missing conversation\|missing current entry\|restarted production sweeper'` | 0 | 7 evidence cases pass |
| `env DBUS_SESSION_BUS_ADDRESS=unix:path="$TMPDIR/absent-bus" bun test scripts/gate-properties.test.ts` | 0 | 2 clean skips |
| `bun test scripts/owned-runner.integration.test.ts -t 'actual gate runner (exit\|timeout)'` | 0 | 2 pass; real service exit/deadline cleanup preserves bystanders |
| `node node_modules/typescript/bin/tsc --noEmit --incremental false` | 2 | New environment-parameter typing error identified |
| `node node_modules/typescript/bin/tsc --noEmit --incremental --tsBuildInfoFile "$TMPDIR/verified.tsbuildinfo"` | 0 | Full typecheck passes; no prior build-info file existed |
| `bun scripts/build-gate.ts` | 0, 0 | Both final shipped gate entries bundle |
| `bun "$TMPDIR/bundle-smoke.ts"` | 0, 0 | Bundled admission claims a private queue; bundled owned runner executes `/bin/true` |
| `bash -n scripts/gate-slot.sh` | 0 | Shell syntax passes |
| `git diff --check` | 0 on every invocation | No whitespace errors |

ESLint ran twice, both exits 0, using this command (argument order differed):

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
failures above; the corrected serial wrapper exited 0. All tests and probes
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
