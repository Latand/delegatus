# Fresh producers after publication refusal

A passed stage can retain an accepted commit that the repository's pre-push
hook refuses. The existing producer continuation remains the first repair
opportunity. Once it has settled or cannot be delivered, type, lint and test
refusals can start a fresh producer attempt on the same lane. A manual
`retry-stage` takes this path too, including when the previous producer is
resident and idle. Transport, capacity and privacy recovery keep their
existing policies.

`publicationCodeRepairDetail` classifies the captured hook verdict.
`publicationProducerRepairReady` checks the original producer identity,
current activity, transcript progress and background tasks. Existing delivery
guards and the twenty-minute recovery bound remain authoritative for a quiet,
expired repair whose runtime evidence is unavailable. A fresh attempt receives the
refusal output and the current stage instructions, owns new launch and Git
receipts, and reports normally. Its normal pass edge returns changed content
to the lane's review stages with the producer's original activation.
The production port reads the native owner last: active work, pending attention
and an ownership conflict remain holds even after the ordinary repair deadline.
Before dispatch, a moved native producer head must pass the existing creation
receipt checks and retain the accepted head as an ancestor. The accepted head
itself can be a controller commit of dirty producer output. A foreign suffix,
rewritten accepted history or a head raced during that proof parks the new
attempt before it can consume the checkout.

`startPublicationProducerRepair` is shared by controller recovery and manual
retry. It preserves the accepted head and the passed attempt, records the
settled publication failure, retires the failed publication operation and
creates the pending producer. The board shows another attempt and its repair
round. Each new attempt stores `publicationRepairFrom` with the source stage,
source attempt and lane-wide round. The pipeline's `publicationProducerRepairs`
counter owns the budget; an absent counter means zero. Recovery reads that
counter without enumerating retained attempts. The state store validates the
counters and preserves them through loading, cloning and restart. The lane allows
two automatic or `retry-stage` producer repairs. Exhaustion parks with the hook cause and the
exhaustion reason; another retry cannot silently reset the budget.

The regression file is `src/lib/pipelines/publicationProducerRepair.test.ts`.
It runs real repository hooks, starts fresh engine attempts, commits a repair
and verifies the resulting branch on a local bare remote. It also calls the
exported MCP HTTP route with an SDK client, exercising bindings, policy,
receipts, busy-producer refusal and replay. A separate controller process
reopens stored attempts to verify that exhaustion survives restart.

## Settlement of the one-time continuation

The producer may leave a repair uncommitted. A successful continuation goes
through `commitPipelineStage` and the repository hooks. Changed content requires
fresh review when the repairing producer differs from the accepting attempt,
or when the accepting attempt is a reviewer. The review cursor retains its
original activation and budget metadata; the original approval stays in history.
A metadata-only rewrite keeps the existing content comparison rule.

An explicit refusal first records its reason, then restores the clean branch
and head proved before delivery. Cleanup snapshots the index and working tree
through a private Git index, including repair-created untracked files, and saves
its restore/clean checkpoint before changing files. Restart can finish a restore
or a partially completed clean without another producer turn. An interrupted Git
cleanup stays pending for automatic recovery. The write child rechecks its held
settlement lock, branch, head and file/index metadata after the executor's
asynchronous fences, under its own deadline. These checks keep synchronous
filesystem work outside the Viewer event loop. The clean handoff records existing
ignored files and collapsed ignored directories before dispatch. Cleanup restores
their index entries without deleting their worktree contents, even when the repair
removes an ignore rule and stages or commits them. This protection survives a
controller restart. The controller's private handoff namespace stays outside
cleanup. Older handoffs without this inventory preserve newly tracked contents
and refuse destructive recovery. A moved head
needs the original producer's creation receipts for the entire repair suffix.
Proven repair commits are recorded in the cleanup checkpoint;
a guarded compare-and-swap restores the pre-repair ref before the index and
worktree are restored. Restart accepts either side of that ref write. A foreign
head, changed branch or changed snapshot refuses destructive cleanup with the
original refusal reason; current producer activity, pending delivery and
background work hold cleanup.
For dirty output, unknown native activity keeps cleanup pending past the turn
deadline. An already-clean accepted head keeps the existing delivery/deadline
settlement and live-producer retry policy.
Older records without a clean handoff proof permit only an already-clean retry.
Settlement holds the publisher's kernel lock. A running publication, including
an uncertain result whose child has finished, keeps its operation and child
receipt until remote reconciliation. Only the original refused operation is
removed by repair settlement. A pending replacement is proved unexecuted under
the lock and recorded as superseded; a subsequent publication follows the
ordinary admission path. Both commit settlement and refusal cleanup wait for
this custody.

After a settled refusal, `retry-stage` can retry the retained accepted head
without asking for a commit-or-discard decision.

A pending publication whose admission fence has changed settles as `superseded`
before execution. History retains that disposition while failure and attempt
counters remain unchanged, including through takeover and restart. The controller
reserves a replacement only through its current ownership checks and admission
fence. Supersession after a remote write begins retains the existing uncertain
publication recovery.

The regression cases in `stagePublicationRepair.test.ts` cover dirty refusals,
restart during cleanup, concurrent changes, superseded admission and takeover.
`publicationHistory.test.ts` checks counter preservation and reader compatibility.
`publicationRepairIgnored.test.ts` checks handoff-ignored files across staging,
commits, changed ignore rules, partial cleanup and a new controller process.

## Historical verification on 2026-11-12

Tests use the project's `bun test --timeout=60000 <file>` command through
`scripts/gate-slot.sh`, one explicit file per invocation. Each invocation uses
a scratch source export and a fresh `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and
`LLV_STATE_DIR`. The base comparison uses the same interpreter, isolation and
test file against base `f9571ba01c`. The interpreter is Bun 1.4.0.
No performance improvement is claimed.

The focused coverage comprises these files:

| File under `src/lib/pipelines/` | Behavior cases |
| --- | ---: |
| `publicationProducerRepair.test.ts` | 22 |
| `publicationRecovery.test.ts` | 72 |
| `publicationRecovery.gateFaults.test.ts` | 65 |
| `engine.publication.test.ts` | 36 |
| `publicationRepairRetry.test.ts` | 7 |
| `publicationRepairRecovery.test.ts` | 8 |
| `stagePublicationRepair.test.ts` | 21 |

The legacy `stagePublicationRepair.test.ts` also reports an unnamed owned-child
teardown failure in this environment. The same failure reproduces on the pinned
base with all 21 behavior cases passing. Preserve its actual nonzero exit in
the check handover. New producer tests fail on the base because it republishes
or refuses the accepted attempt instead of creating the required repair.

Changed TypeScript files are checked with
`bun node_modules/eslint/bin/eslint.js <changed TypeScript paths>`. Publication
text is checked with the repository's privacy gate and committed fingerprints:
`bun scripts/privacy-publication-gate.ts --require-known-values --paths <changed paths>`
with `LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE` naming
`scripts/privacy-known-value-fingerprints.json`. The stage commits through the
repository hooks. The pipeline owns pre-push verification and PR creation.
