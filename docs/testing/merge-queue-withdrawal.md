# Merge queue withdrawal

On the starting main `dfc99dce253fe29148b70d5840bf903cd1e47c19` and the
rechecked main `34b741354731f3c63cc2531c6fee12b1dcd2f911`, closing a lane left its
merge entry in the previous state. A delivery successor without its own merge
record also left the predecessor able to send a merge. The final regression
selection fails 27 tests on that main revision; its unchanged-owner control
passes. The mechanical-update cases also reproduce a push after a completed
successor takes delivery.

Closing a lane now persists cancellation of its undispatched merge before
teardown. Explicit takeover withdraws the predecessor in the ownership
transaction. The sweep retires older records, including when the newer owner
has no merge record. Merge dispatch binds the delivery and reservation read
before asynchronous work and checks them again after credential acquisition.
A replaced or cleared reservation authorizes no write. Base-update pushes and
refresh creation also recheck delivery. Outstanding landing receipts remain
read-only obligations after closure or takeover; known terminal forge results
keep their reasons. Already withdrawn records need no further writer admission.

The shared write paths are pipeline-store validation (close, discard and every
persisted copy), terminal publication release, explicit delivery takeover and
the merge runner's reservation and reconciliation commits. Completion still
releases publication without revoking the completed owner's merge. Queue
selection, refresh delegation, base-update replay, attention projections and
task completion consume the existing merge states. No stored field or schema
changes. Tests use the real close, takeover, serializer and fresh-process reader
alongside deterministic forge and clock ports. No performance gain is claimed.

Open overlapping work was inspected in the durable-integration, refresh-capacity,
decision-fence and provisioning changes. Their schemas, engine control paths,
capacity policy and provisioning implementation are outside this repair.

All test runs use a source export under the stage scratch directory. Each run
has fresh HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR directories and a closed
Viewer control endpoint. The repository test preload additionally isolates
account roots, removes publication Git bindings and supervises child processes.
The native Git executable was verified to have an ELF header.

The command, exit status, test counts, assertion counts and filter for every
recorded run are in [the check ledger](../../evidence/merge-queue-withdrawal.json).
It retains intermediate failures and their baseline comparisons. Reproduction
commands use the final tests on the pinned main source; final candidate commands
use the repaired source. Full passing files cover the runner, persisted merge
state, refresh and mechanical-update behavior, and pipeline-store behavior.

Run each test file through the controller-provided gate wrapper, one at a time:

```sh
bash "$GATE" --record "$TMPDIR/check.log" \
  bash "$SCRATCH_EXPORT/run-check" run-name \
  bun run test src/lib/forge/autoMerge.test.ts
```

`run-check` changes into the export, creates the four isolated directories under
its run-name root, sets the closed control endpoint, and executes its remaining
arguments. Repeat by explicit path for `autoMergeStore.test.ts`,
`autoRefresh.test.ts` and `src/lib/pipelines/store.test.ts`. Use a fresh log and
run-name for each invocation. After recording starts, call the native
`wait_for_check` once with that absolute log path and keep the stage alive until
its terminal result. Final lint and privacy are recorded in the ledger. The stage report also
records the plain commit hook verdict. Publication and PR creation belong to the pipeline;
its pre-push gate performs the publication checks, including typechecking.
