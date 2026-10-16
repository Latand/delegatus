# Stage launch recovery

A pipeline stage retains its attempt, checkout and input while its controller
recovers a launch. The originating requirement is dated 2026-10-15. Measurements
and source hashes are in `evidence/stage-launch-recovery/readings.json`.

## Receipt decisions

| Finding | Change | Regression in the existing test files |
| --- | --- | --- |
| F1 | Reserve once, then retry idempotent membership outside the registry writer under one deadline. Preserve typed contention. | `launchMembership.test.ts`: typed deferral, real peer writer, advancing independent timer, authority withdrawal and deadline/replay. |
| F2 | Defer storage admission contention before an identity is bound. Preserve a failed replay before membership can overwrite its admission proof. An unadmitted failed receipt with no host, native key, artifact or conversation generation takes the existing retry claim and persisted backoff. | `engine.recovery.test.ts`: raw SQLite busy/locked admission, typed deferrals, executor exit before binding, legacy park, concurrent controllers, manual collision, late completion, withdrawn proof and exhaustion after a controller process restart. |
| F3 | Seed the existing recovery envelope in lookup-only uncertainty. Reconcile the original launch and first-message operations, current generation and timely native turn. | `engine.recovery.test.ts`: incomplete replay without an envelope; operation conflict, generation conflict, generation changes across awaited reads/completion, stale turn and absent evidence. |

Before a reservation callback binds any launch, conversation, transcript or pane,
raw SQLite busy/locked messages and codes, registry contention and typed lease
or account-commit deferrals use the existing durable ten-minute launch budget.
The controller books backoff outside the spawn call. A restart preserves the
budget's origin, elapsed time and rounds. Reserved identities follow receipt
reconciliation; permanent storage errors retain their recorded cause.

F2 uses the same `pipeline:stage:launch` claim as manual retry. A busy claim
keeps the original launch in spawning with durable backoff; it retires nothing
until the claim commits. `spawnCalls`,
retired launches and the controller wait remain durable. The attempt keeps its
checkout and input. A receipt completed during the claim is adopted through the
existing settlement path. A conflicting claim retains the original launch and
its recorded failure.

F3 uses the existing ten-minute recovery window and sixteen-check cap. Its
uncertain phase permits operation lookups and settlement. It sends no first
prompt. A matching native turn can restore the original attempt to running
while completion confirmation lags. The current generation and original native
entry must agree on the reserved path; retained generation ids from older
filenames remain valid. Receipt, generation and native-entry evidence is read
fresh in one keyed transaction after awaited transcript reads. The regression
reuses one ports instance and changes the real registry during that await.
Conflicting operation identities or a changed generation name the conflict.
A spent observation budget retains the original identities and names the
missing evidence. The success regression
requires one host start, one first prompt and the same stage attempt.

The new envelope write waits through registry asynchronous admission, rechecks
eligibility inside the write and records the `pipeline.spawn-evidence` origin
under the existing `pipelines.evidence` loop-monitor label. Its peer-writer test
requires an independent timer to advance and rejects authority withdrawn during
the wait. This change makes no throughput or latency improvement claim.

## Shared paths

The F1 entry is used by the spawn command, task spawn route, pane launcher,
pipeline adapter and structured resume recovery. The synchronous entry keeps
its existing contract. The membership prerequisite retains its original task
identity and error behavior for permanent refusals.

`neverBegan` and `currentGeneration` are optional fields on the pipeline port's
receipt projection. They add no stored schema. The default adapter derives
both from the registry; custom ports may omit them. Spawn replay, parked
reconciliation and native-turn adoption consume them. Every retry-claim caller,
including remote actions and manual retry, awaits asynchronous admission.

## Parallel work

The final branch merges current main at `d395e7c73`, including PRs #2951 and #2953.
Its shared F1 admission and initial three membership regressions are inherited
from main. This branch adds peer release and deadline coverage. The separate
`spawnEvidence` reader in `registry.ts` supplies fresh F3 evidence without
loading unrelated history. Missing historical launches reuse the pass projection;
existing launches read fresh evidence. The pipeline adapter preserves terminal
replay evidence before another membership admission can erase it.

The asynchronous retry-claim interface and its awaited callers are inherited
from PR #2953. The additional pipeline handling bounds busy claims and rechecks
the receipt after asynchronous admission.

## Replay the checks

Use a scratch export with the pinned dependencies. For every invocation, choose
private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR directories. Run each
command through the project's `scripts/gate-slot.sh` admission wrapper:

```sh
bun test src/lib/tasks/launchMembership.test.ts
bun test src/lib/pipelines/engine.recovery.test.ts
bun test src/lib/pipelines/engine.creation.test.ts
bun test src/lib/pipelines/spawnRestartRecovery.test.ts
bun test src/lib/pipelines/engine.ports.test.ts
bun test src/lib/agent/registry.writerWait.test.ts
bun test src/lib/pipelines/runtimeSwitch.test.ts
bun test src/lib/pipelines/engine.providerBudget.test.ts
./node_modules/.bin/tsc --noEmit --incremental false
```

For the red comparison, copy only the changed test files into an export of the
recorded main revision and select the regression names listed in the readings.
Keep the same runtime and isolation. The full changed test files run on the
candidate. The publication hook also runs its own type, lint, touched-test,
platform and privacy checks. Required PR checks are recorded separately from
local checks.

The publication hook refused the provider-budget file at its five-minute
deadline. The final serial file passes all 164 tests; main serial controls
also pass. The stopped Linux backend and explicit platform files pass
separately. The readings record these results and the repository-documented
publication exception used for this timeout.
