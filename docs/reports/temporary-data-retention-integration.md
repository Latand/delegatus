# Temporary-data retention integration validation

## Read-only directory successor

To verify this repair, run the permission-hold regressions in
`src/lib/runtime/temporaryDataRetention.test.ts` against the published
`0bc574a773` production code first. Then run the final tree's 21 files from
the predecessor's final review, each in a separate gated command and private
HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, with a closed Viewer control
endpoint. Run types, touched-file lint and privacy, commit, and invoke the
unmodified pre-push hook on that commit. The command results below supplement
the historical integration evidence.

The repair chooses intent (a): a directory missing owner write or search
permission is held as `permission-repair-needed` during protection inspection.
This uses the existing bounded physical walk and avoids permission changes.
The existing claimed, identity-bound restoration path returns a replayed
quarantine to its original path and clears its intent before releasing custody.
The authority, reference, mount, preservation and final mutation checks retain
their existing contracts. No retention lifetime or deletion eligibility expands.

The shared-path audit covers `temporaryDataProduction.ts` (candidate discovery,
authority and retirement claims), `temporaryDataStore.ts` (candidate identity and
persisted reason), `temporaryDataRetention.fixture.ts` (real process restart),
`tempSweep.ts` (quarantine writer and replay reader), and
`pipelines/retirementClaim.ts` (identity-bound restoration). No persisted format
changes. Both fresh inspection and trash replay use the same protection walk;
dry-run uses that inspection while preserving its existing no-restoration rule.

Four regressions cover fresh and legacy-trash replay with modes `0555` and
`0600`. The search-permission variant also receives the stable named reason.
Replay setup uses the real quarantine writer and a real EACCES removal failure.
Recovery reopens the ledger in a new process, checks two ticks, the original
inode, unchanged mode and payload, persisted reason, and absence of trash and
intent. Restoring permissions in test cleanup permits a later successful sweep.

Notes: a continuously busy ancestor can starve the final poll until its
deadline; the worktree sweep's test-only `removeTree` port lacks `started()`.
Both remain outside this repair and are unchanged. No performance gain is claimed.

### Successor command results

Each test row invokes `bash "$GATE" bun run test ./<file>`, one file at a time.
`GATE` is the launch-provided wrapper. Each command receives fresh private
`HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`, with
`LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. A recorded campaign holds one
admission; every child verifies inherited slot reuse and invokes the wrapper.
The actual child exits and pass/fail/skip counts are retained in stage evidence.

| Tree / command or explicit test path | Exit | Pass/fail/skip |
| --- | ---: | --- |
| Published head: `bun run test ./src/lib/runtime/temporaryDataRetention.test.ts --test-name-pattern "permission hold"` | 1 | 0/4/0; 69 filtered |
| First preservation run: `src/lib/runtime/temporaryDataRetention.preservation.test.ts` | 1 | 77/1/0 |
| Merged baseline preservation comparison: same path | 0 | 78/0/0 |
| `src/lib/agent/registry.temporaryData.test.ts` | 0 | 3/0/0 |
| `src/lib/dockerCacheRetention.test.ts` | 0 | 10/0/0 |
| `src/lib/pipelines/worktreeSweepWorker.test.ts` | 0 | 38/0/0 |
| `src/lib/retentionTestSafety.test.ts` | 0 | 6/0/0 |
| `src/lib/runtime/attemptEvidenceBinding.test.ts` | 0 | 8/0/0 |
| `src/lib/runtime/attemptMutationFence.test.ts` | 0 | 17/0/0 |
| `src/lib/runtime/attemptTempFilesystem.permissions.test.ts` | 0 | 27/0/5 |
| `src/lib/runtime/attemptTempRetention.liveness.test.ts` | 0 | 3/0/0 |
| `src/lib/runtime/attemptTempRetention.permissions.test.ts` | 0 | 25/0/5 |
| `src/lib/runtime/attemptTempRetention.removalFences.test.ts` | 0 | 25/0/0 |
| `src/lib/runtime/attemptTempRetention.test.ts` | 0 | 143/0/0 |
| `src/lib/runtime/temporaryDataProduction.recovery.test.ts` | 0 | 13/0/0 |
| `src/lib/runtime/temporaryDataProduction.test.ts` | 0 | 29/0/0 |
| `src/lib/runtime/temporaryDataRetention.preservation.test.ts` | 0 | 78/0/0 |
| `src/lib/runtime/temporaryDataRetention.test.ts` | 0 | 73/0/0 |
| `src/lib/selfUpdate/gatedTrash.test.ts` | 0 | 17/0/0 |
| `src/lib/selfUpdate/releaseObserver.test.ts` | 0 | 8/0/0 |
| `src/lib/selfUpdate/retention.test.ts` | 0 | 135/0/0 |
| `src/lib/tempSweep.test.ts` | 0 | 88/0/0 |
| `src/lib/runtime/attemptCopyDiscovery.test.ts` | 0 | 3/0/0 |
| `src/lib/runtime/attemptTempProduction.test.ts` | 0 | 65/0/1 |
| `bun scripts/privacy-publication-gate.ts --repository "$EXPORT" --require-known-values --paths src/lib/runtime/temporaryDataRetention.ts src/lib/runtime/temporaryDataRetention.test.ts docs/reports/temporary-data-retention-integration.md successor-pr-body.md` | 0 | zero findings |
| `bunx --no-install tsc --noEmit` | 0 | zero diagnostics |
| `bun node_modules/eslint/bin/eslint.js src/lib/runtime/temporaryDataRetention.ts src/lib/runtime/temporaryDataRetention.test.ts` | 0 | zero diagnostics |

The final selection totals **814 pass / 0 fail / 11 existing opt-in skips**.
The first preservation run held the `hop none (replay=false)` control instead
of removing it. A fresh full-file baseline comparison and full-file head repeat
each passed 78/78. No fence or preservation assertion was changed.
Both 0555 cases and both 0600 cases fail before the repair and pass afterward.
The two replay cases first create an actual EACCES removal failure with the
real writer's trash and intent, then recover on the next tick.

The identical three-tick 0555 probe (`bash "$GATE" bun ./permission-timing.ts`
in each scratch tree) exited 0 on both trees. Baseline ticks took 29.25, 21.23
and 19.41 ms: each retained one trash directory and one intent with EACCES.
Final ticks took 8.75, 2.63 and 3.52 ms: each kept the original path with
`permission-repair-needed`, zero trash and zero intents. These diagnostic
tick timings cover one root and one file.
The probe exists only in stage scratch and is absent from the commit.

Publication verification runs after this report is committed. The final
unmodified pre-push hook exit and published-text read-back are recorded in the
pull request description and retained stage command ledger.

## Earlier integration validation

To verify this integration, export its committed tree into private stage scratch,
install the pinned dependencies there, and give each command private `HOME`,
`XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`. Set
`LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. Run every test file separately through
the launch-provided `scripts/gate-slot.sh`, with each recorded log inside the
launch temporary root. No test enumerates the installation's real temporary roots.

This integration supersedes #3943 and #3894. Both reviewed heads are preserved
through merge commits: `d1e6883313a5d52306e0b649f3b6b068c198348f` and
`33d553413b6e3e2faf85a9cc53526c982e2cf380`. Base:
`ce7806df4acef79bbf76221943227e86c59863a9`; combined merge:
`ded2c9588177eb76be7fece6906974508504b609`. Main stayed at that base during the
initial integration. The initial observations and command table below are
historical; the crash-recovery follow-up records the later implementation.
Bun 1.4.0 executed these checks.

## Integration and contracts

`src/lib/tempSweep.ts` keeps W4's mutation-start callback and restoration before
irreversible removal. Retention's synchronous dispatch fence follows final root
identity validation; a refusal or throw restores fresh quarantine. Replay keeps
both callback arguments and the dispatch fence.

The combined tree reproduced 36 preservation failures and nine self-update
retention failures. Each failed while constructing replay: the old fixtures threw
before announcing removal start and expected a surviving journal. W4 restores the
original root and clears that journal. The replay fixtures now call `started()`
before simulating an interrupted native removal. Their preservation assertions
are unchanged. The same legacy setup correction applies to two gated-trash tests.
New tempSweep controls actually unlink an entry after start, retain the partial
tree through a dispatch refusal, finish it on replay, and separately prove that a
pre-start refusal restores the original inode and bytes before a later removal.

The shared-path audit covered the journal writer and replay reader, generic
stale-temp sweep, attempt retention's permission-aware remover, temporary-data
retention, evidence-copy retention, worktree retention, and self-update's legacy
journal adoption. Default native removers announce start themselves; attempt
retention forwards the callback to `removeAttemptTree`. Its reversible permission
repair rolls back before a pre-removal refusal restores the root. Snapshot replay
continues to admit missing entries after an interrupted deletion.

## Other batch failures

The pair introduced five new test files that wrote keep markers directly. Those
conflicted with #3964's helper contract. They now use its byte-identical reviewed
`src/lib/runtime/keepMarker.testSupport.ts`, with `afterEach` cleanup. The retained
batch plus these five writer changes passes the unchanged guard, 12/12. The guard
and transport files themselves are scratch-only compatibility inputs; they are
absent from this pair's main base. The first pair-only guard probe also exposed
older writers that #3964 migrates in the full batch, producing an additional
child-leak failure there. No guard assertion was weakened.

The three transport failures reproduce on both main and the pair. The launch's
GitHub App Git shim invokes `bun`; the hook fixture substitutes its recorder for
`bun`, so pushes return success without updating the fixture remote or executing
its hook. Restricting native Git to the isolated check environment gives 6/6 on
both trees. This pair does not cause those failures. No admission, owned-runner,
registry or host-termination repair was added beyond the reviewed inputs.

## Initial integration observations

The two required retention files pass 72/72 and 135/135. Every W4 file passes.
All 51 files selected by the repository's touched-file rule, plus copy discovery,
were run individually: 1,472 passes, 25 skips, three pre-existing failing assertions.
The repository comparator exits zero for both affected registry files, reporting
zero introduced failures and respectively one and two pre-existing assertions.
They concern nesting-policy fixture cleanup and capability-handover HTTP 403.
The namespace-dependent tests and opt-in benchmark account for the 25 skips.

The production build passed on the combined merge before reproduction. Later
crash-recovery repairs change production inputs, so that build supplies no verdict
for the current recovery implementation. W4's permission-refusal cases verify restored root/modes,
working consumer links, cleared intent and successful later retirement. The
preservation matrix verifies late records, payload bytes, inode identity and
replay; its unchanged controls still remove eligible trees.

## Initial integration command results

Each row uses `bash "$GATE" --record "$TMPDIR/<run>.log" <command>`, with
`GATE` supplied by the launch and an isolated child environment. Counts are
pass/fail/skip; a dash means the command is not a test runner. Source trees called
combined include the working-tree integration fixes after the reproduction rows.
The two comparator rows report introduced/pre-existing failures separately below.
For privacy, `WORKTREE` names the assigned checkout whose staged bytes are scanned;
the checking process still runs from the scratch export.
Intermediate failed migrations are retained, followed by their corrected runs.
The first migration accidentally treated two `.git` variables as keep markers;
those writes were corrected. The first batch guard rerun caught one line carrying
both a payload write and a helper call; splitting the operations resolved it.

| Run | Tree | Command | Exit | Pass/fail/skip |
| --- | --- | --- | ---: | --- |
| repro-build | combined | `bun run build` | 0 | — |
| repro-preservation | combined | `bun run test ./src/lib/runtime/temporaryDataRetention.preservation.test.ts` | 1 | 36/36/0 |
| repro-self-retention | combined | `bun run test ./src/lib/selfUpdate/retention.test.ts` | 1 | 126/9/0 |
| repro-marker | combined | `bun run test ./src/lib/runtime/keepMarker.guard.test.ts` | 1 | 10/2/0 |
| repro-transport | combined | `bun run test ./scripts/local-gate.hooks.transport.test.ts` | 1 | 3/3/0 |
| base-self-retention | main | `bun run test ./src/lib/selfUpdate/retention.test.ts` | 0 | 133/0/0 |
| reviewed-preservation | #3943 reviewed | `bun run test ./src/lib/runtime/temporaryDataRetention.preservation.test.ts` | 0 | 72/0/0 |
| base-transport | main | `bun run test ./scripts/local-gate.hooks.transport.test.ts` | 1 | 3/3/0 |
| head-transport-native | combined, native Git | `bun run test ./scripts/local-gate.hooks.transport.test.ts` | 0 | 6/0/0 |
| base-transport-native | main, native Git | `bun run test ./scripts/local-gate.hooks.transport.test.ts` | 0 | 6/0/0 |
| fixed-preservation | combined | `bun run test ./src/lib/runtime/temporaryDataRetention.preservation.test.ts` | 0 | 72/0/0 |
| fixed-self-retention | combined | `bun run test ./src/lib/selfUpdate/retention.test.ts` | 0 | 135/0/0 |
| fixed-temp-sweep | combined | `bun run test ./src/lib/tempSweep.test.ts` | 0 | 84/0/0 |
| final-01 | combined | `bun run test ./src/lib/runtime/attemptMutationFence.test.ts` | 1 | 15/2/0 |
| final-01-corrected | combined | `bun run test ./src/lib/runtime/attemptMutationFence.test.ts` | 0 | 17/0/0 |
| final-02 | combined | `bun run test ./src/lib/runtime/attemptTempRetention.removalFences.test.ts` | 0 | 25/0/0 |
| final-03 | combined | `bun run test ./src/lib/runtime/attemptTempRetention.test.ts` | 0 | 143/0/0 |
| final-04 | combined | `bun run test ./src/lib/runtime/attemptTempRetention.permissions.test.ts` | 0 | 23/0/5 |
| final-05 | combined | `bun run test ./src/lib/runtime/attemptTempFilesystem.permissions.test.ts` | 0 | 27/0/5 |
| final-06 | combined | `bun run test ./src/lib/runtime/attemptTempFilesystem.test.ts` | 0 | 65/0/14 |
| final-07 | combined | `bun run test ./src/lib/runtime/attemptTempProduction.test.ts` | 0 | 65/0/1 |
| final-08 | combined | `bun run test ./src/lib/runtime/attemptCopyDiscovery.test.ts` | 0 | 3/0/0 |
| final-09 | combined | `bun run test ./src/lib/runtime/attemptTempRetention.liveness.test.ts` | 0 | 3/0/0 |
| final-10 | combined | `bun run test ./src/lib/runtime/temporaryDataRetention.test.ts` | 0 | 40/0/0 |
| final-11 | combined | `bun run test ./src/lib/runtime/temporaryDataProduction.test.ts` | 0 | 29/0/0 |
| final-12 | combined | `bun run test ./src/lib/runtime/attemptEvidenceBinding.test.ts` | 0 | 8/0/0 |
| final-13 | combined | `bun run test ./src/lib/selfUpdate/gatedTrash.test.ts` | 0 | 17/0/0 |
| final-14 | combined | `bun run test ./src/lib/selfUpdate/releaseObserver.test.ts` | 0 | 8/0/0 |
| final-15 | combined | `bun run test ./src/lib/dockerCacheRetention.test.ts` | 0 | 10/0/0 |
| final-16 | combined | `bun run test ./src/lib/retentionTestSafety.test.ts` | 0 | 6/0/0 |
| final-17 | combined | `bun run test ./src/lib/pipelines/worktreeSweepWorker.test.ts` | 0 | 38/0/0 |
| final-18 | combined | `bun run test ./src/lib/agent/registry.temporaryData.test.ts` | 0 | 3/0/0 |
| final-batch-marker | batch compatibility | `bun run test ./src/lib/runtime/keepMarker.guard.test.ts` | 1 | 11/1/0 |
| touched-01 | combined | `bun run test ./src/lib/agent/registry.admission.test.ts` | 1 | 13/1/0 |
| touched-02 | combined | `bun run test ./src/lib/agent/registry.backendResolution.test.ts` | 0 | 5/0/0 |
| touched-03 | combined | `bun run test ./src/lib/agent/registry.deliveryCompaction.test.ts` | 0 | 2/0/0 |
| touched-04 | combined | `bun run test ./src/lib/agent/registry.deliveryRead.test.ts` | 0 | 7/0/0 |
| touched-05 | combined | `bun run test ./src/lib/agent/registry.engineNative.test.ts` | 0 | 2/0/0 |
| touched-06 | combined | `bun run test ./src/lib/agent/registry.migrationBinding.test.ts` | 0 | 18/0/0 |
| touched-07 | combined | `bun run test ./src/lib/agent/registry.migrationStop.orderingClocks.test.ts` | 0 | 40/0/0 |
| touched-08 | combined | `bun run test ./src/lib/agent/registry.migrationStop.orderings.test.ts` | 0 | 21/0/0 |
| touched-09 | combined | `bun run test ./src/lib/agent/registry.migrationStop.test.ts` | 0 | 63/0/0 |
| touched-10 | combined | `bun run test ./src/lib/agent/registry.open.test.ts` | 0 | 10/0/0 |
| touched-11 | combined | `bun run test ./src/lib/agent/registry.openUnderWriter.test.ts` | 0 | 7/0/0 |
| touched-12 | combined | `bun run test ./src/lib/agent/registry.projectOwnership.test.ts` | 0 | 8/0/0 |
| touched-13 | combined | `bun run test ./src/lib/agent/registry.reseat.test.ts` | 0 | 28/0/0 |
| touched-14 | combined | `bun run test ./src/lib/agent/registry.retentionRead.test.ts` | 0 | 4/0/0 |
| touched-15 | combined | `bun run test ./src/lib/agent/registry.servingWriters.test.ts` | 0 | 19/0/0 |
| touched-16 | combined | `bun run test ./src/lib/agent/registry.spawnAdmission.test.ts` | 0 | 18/0/0 |
| touched-17 | combined | `bun run test ./src/lib/agent/registry.spawnCapabilityHandover.test.ts` | 1 | 4/2/0 |
| touched-18 | combined | `bun run test ./src/lib/agent/registry.spawnHistory.test.ts` | 0 | 5/0/0 |
| touched-19 | combined | `bun run test ./src/lib/agent/registry.sqlite.test.ts` | 0 | 69/0/0 |
| touched-20 | combined | `bun run test ./src/lib/agent/registry.sqliteOnly.test.ts` | 0 | 11/0/0 |
| touched-21 | combined | `bun run test ./src/lib/agent/registry.targetedHistory.test.ts` | 0 | 9/0/0 |
| touched-22 | combined | `bun run test ./src/lib/agent/registry.test.ts` | 0 | 137/0/0 |
| touched-23 | combined | `bun run test ./src/lib/agent/registry.writerWait.test.ts` | 0 | 30/0/0 |
| touched-24 | combined | `bun run test ./src/lib/agent/sqliteRegistryStore.archivedOwner.test.ts` | 0 | 5/0/0 |
| touched-25 | combined | `bun run test ./src/lib/agent/sqliteRegistryStore.history.test.ts` | 0 | 18/0/0 |
| touched-26 | combined | `bun run test ./src/lib/agent/sqliteRegistryStore.keyedWrites.test.ts` | 0 | 11/0/0 |
| touched-27 | combined | `bun run test ./src/lib/agent/sqliteRegistryStore.readOnlyView.test.ts` | 0 | 71/0/0 |
| touched-28 | combined | `bun run test ./src/lib/agent/sqliteRegistryStore.readerGenerations.test.ts` | 0 | 2/0/0 |
| touched-29 | combined | `bun run test ./src/lib/agent/sqliteRegistryStore.refresh.test.ts` | 0 | 5/0/0 |
| touched-30 | combined | `bun run test ./src/lib/agent/sqliteRegistryStore.viewAccessors.test.ts` | 0 | 8/0/0 |
| touched-31 | combined | `bun run test ./src/lib/tempSweep.cap.test.ts` | 0 | 1/0/0 |
| compare-registry-admission | combined / main | `bun scripts/local-gate-tests.ts --base ce7806df4acef79bbf76221943227e86c59863a9 ./src/lib/agent/registry.admission.test.ts` | 0 | — |
| compare-capability | combined / main | `bun scripts/local-gate-tests.ts --base ce7806df4acef79bbf76221943227e86c59863a9 ./src/lib/agent/registry.spawnCapabilityHandover.test.ts` | 0 | — |
| final-batch-marker-corrected | batch compatibility | `bun run test ./src/lib/runtime/keepMarker.guard.test.ts` | 0 | 12/0/0 |
| final-removal-fences | combined | `bun run test ./src/lib/runtime/attemptTempRetention.removalFences.test.ts` | 0 | 25/0/0 |
| final-types | combined | `bunx tsc --noEmit` | 0 | — |
| final-eslint | combined | `bun scripts/eslint-changes.ts --base ce7806df4acef79bbf76221943227e86c59863a9 ./scripts/temporary-data-dry-run.ts ./src/lib/agent/registry.temporaryData.test.ts ./src/lib/agent/registry.ts ./src/lib/agent/sqliteRegistryStore.ts ./src/lib/dockerCacheRetention.test.ts ./src/lib/dockerCacheRetention.ts ./src/lib/pipelines/worktreeSweep.fixture.ts ./src/lib/pipelines/worktreeSweepWorker.test.ts ./src/lib/pipelines/worktreeSweepWorker.ts ./src/lib/retention.worker.ts ./src/lib/retentionTestSafety.test.ts ./src/lib/retentionTestSafety.ts ./src/lib/runtime/attemptEvidenceBinding.test.ts ./src/lib/runtime/attemptEvidenceBinding.ts ./src/lib/runtime/attemptEvidenceCopies.ts ./src/lib/runtime/attemptMutationFence.test.ts ./src/lib/runtime/attemptMutationFence.ts ./src/lib/runtime/attemptTempDiagnostics.ts ./src/lib/runtime/attemptTempFilesystem.permissions.test.ts ./src/lib/runtime/attemptTempFilesystem.ts ./src/lib/runtime/attemptTempProduction.ts ./src/lib/runtime/attemptTempRetention.liveness.test.ts ./src/lib/runtime/attemptTempRetention.permissions.test.ts ./src/lib/runtime/attemptTempRetention.removalFences.test.ts ./src/lib/runtime/attemptTempRetention.test.ts ./src/lib/runtime/attemptTempRetention.ts ./src/lib/runtime/keepMarker.testSupport.ts ./src/lib/runtime/temporaryDataProduction.test.ts ./src/lib/runtime/temporaryDataProduction.ts ./src/lib/runtime/temporaryDataRetention.fixture.ts ./src/lib/runtime/temporaryDataRetention.preservation.test.ts ./src/lib/runtime/temporaryDataRetention.test.ts ./src/lib/runtime/temporaryDataRetention.ts ./src/lib/runtime/temporaryDataStore.ts ./src/lib/selfUpdate/gatedTrash.test.ts ./src/lib/selfUpdate/releaseObserver.test.ts ./src/lib/selfUpdate/releaseObserver.worker.ts ./src/lib/selfUpdate/retention.test.ts ./src/lib/tempSweep.test.ts ./src/lib/tempSweep.ts ./src/lib/worktreeSweep.worker.ts` | 0 | — |
| privacy-before-commit | combined | `env LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json bun scripts/privacy-publication-gate.ts --repository "$WORKTREE" --require-known-values --check-commits --added-lines --base ce7806df4acef79bbf76221943227e86c59863a9` | 0 | — |

Comparator outcomes: `compare-registry-admission`: 0 introduced / 1 pre-existing;
`compare-capability`: 0 introduced / 2 pre-existing. Both exit 0. Test runner
errors, deadlines and cleanup failures were absent from these comparisons.

Git integration commands: `git merge --no-ff --no-commit <reviewed #3943 head>`
exited 0; its plain `git commit` exited 0. The corresponding merge of the reviewed
#3894 head exited 1 with the expected tempSweep conflict; conflict resolution,
`git add src/lib/tempSweep.ts` and the plain merge `git commit` exited 0.
`git fetch --no-tags origin main` and `git diff --check` exited 0.
Read-only inspection outputs remain in the private stage transcript. The final plain commit runs the launch's repository hooks.
No branch was pushed from this stage.


## Crash-recovery repair

The follow-up preserves both superseded changes, #3943 and #3894, and repairs two
remaining replay paths beyond the merge. In `src/lib/tempSweep.ts`, replay forwards
the real mutation-start callback. A removal refusal after reversible permission
repair restores the same original inode and cancels the intent before propagating
the reason. A failure after native removal starts retains its partial tree and
journal. Replacement trash and an acquired original remain protected.

In `src/lib/runtime/temporaryDataProduction.ts`, claim admission can read the
verified original when a durable intent exists before rename or after restoration.
The original must match the recorded identity and owner, have a physical parent
on the same filesystem, and have no competing trash path. The existing reconciler
then cancels the intent under the claim and refreshes authority and protection.
Changed ownership, bindings, identities and preservation records still hold data.
No journal format, retention lifetime or admission policy changed; no performance
gain is claimed.

Both review reproductions are committed as regressions. The permission case uses
the real quarantine writer in a child process, checks inode, payload, mode, absent
trash and cleared intent on each refused pass, then proves a later allowed removal.
Production-copy cases use the real production entry point after crashes before
rename and after restore, with an uninterrupted control and ten protection cases.
Four additional replay controls cover pre-start refusal, actual partial deletion,
replacement trash and an acquired original.

Final successful file observations total **870 pass / 0 fail / 25 opt-in skips**
across 23 files, each run separately in private state through the launch gate.
Preservation is 72/72, self-update retention 135/135, permission retention 25 passes
with five skips, production-copy recovery 13/13, and tempSweep 88/88. Types exit 0.
ESLint covers 43 executable files: exit 0, zero errors and one existing unused
variable warning in `src/lib/agent/registry.ts`. No current build result is claimed.

The pre-fix production blobs are from `aaa920abe3`, with the same regression files
and isolation. They reproduce one permission-replay failure (24/1/5) and both copy
crash-window failures (11/2/0); their uninterrupted controls pass. An initial new
permission assertion over-specified callback count; per-pass refusal assertions
replace that count while all restoration assertions remain. The first types run
found a missing required NODE_ENV in the new fixture's ProcessEnv; inheriting the
fixture environment fixes it, and copy recovery and types were renewed.

One production W4 run returned 64/1/1 because a mount-namespace fence deferred one
root. Equivalent pre-fix and fresh repair confirmations both pass 65/0/1. The failed
observation remains recorded; no test or fence was changed for it. The 25 skips
are 24 namespace-dependent cases and one opt-in benchmark.

The keep-marker and transport attribution above remains supported by the prior
independent review: batch guard 12/12 after the pair's five writer migrations;
transport 3/3 failures on both base and integration under the Git shim, 6/6 on each
under native Git. This repair adds no keep-marker writer and changes none of the
transport or gate sources. The earlier three registry baseline failures remain
baseline notes. Current main has advanced; the observed overlap is SQLite-memory
telemetry in `attemptTempRetention.ts`, which this repair leaves untouched.

### Follow-up command results

Every heavy command below uses the same recorded wrapper and isolation described
above. `pre-fix production` replaces only the two repaired production blobs with
those from the pre-fix commit. Counts include diagnostic and expected red runs;
the final 870 count selects the last successful observation for each file.
Native receipts and the complete command journal are retained in stage evidence
under `replay-repair/`. Whitespace, source-manifest and closed-loopback checks exit
0; no push, deployment or live temporary-root sweep was performed.

| Run | Tree | Command | Exit | Pass/fail/skip |
| --- | --- | --- | ---: | --- |
| permission | repair | `bun run test ./src/lib/runtime/attemptTempRetention.permissions.test.ts` | 1 | 24/1/5 |
| copy | repair | `bun run test ./src/lib/runtime/temporaryDataProduction.recovery.test.ts` | 0 | 13/0/0 |
| temp-sweep | repair | `bun run test ./src/lib/tempSweep.test.ts` | 0 | 88/0/0 |
| permission-final | repair | `bun run test ./src/lib/runtime/attemptTempRetention.permissions.test.ts` | 0 | 25/0/5 |
| preservation | repair | `bun run test ./src/lib/runtime/temporaryDataRetention.preservation.test.ts` | 0 | 72/0/0 |
| base-permission | pre-fix production | `bun run test ./src/lib/runtime/attemptTempRetention.permissions.test.ts` | 1 | 24/1/5 |
| base-copy | pre-fix production | `bun run test ./src/lib/runtime/temporaryDataProduction.recovery.test.ts` | 1 | 11/2/0 |
| self-retention | repair | `bun run test ./src/lib/selfUpdate/retention.test.ts` | 0 | 135/0/0 |
| mutation | repair | `bun run test ./src/lib/runtime/attemptMutationFence.test.ts` | 0 | 17/0/0 |
| removal | repair | `bun run test ./src/lib/runtime/attemptTempRetention.removalFences.test.ts` | 0 | 25/0/0 |
| retention | repair | `bun run test ./src/lib/runtime/attemptTempRetention.test.ts` | 0 | 143/0/0 |
| filesystem-permissions | repair | `bun run test ./src/lib/runtime/attemptTempFilesystem.permissions.test.ts` | 0 | 27/0/5 |
| filesystem | repair | `bun run test ./src/lib/runtime/attemptTempFilesystem.test.ts` | 0 | 65/0/14 |
| production | repair | `bun run test ./src/lib/runtime/attemptTempProduction.test.ts` | 1 | 64/1/1 |
| copy-discovery | repair | `bun run test ./src/lib/runtime/attemptCopyDiscovery.test.ts` | 0 | 3/0/0 |
| base-production | pre-fix production | `bun run test ./src/lib/runtime/attemptTempProduction.test.ts` | 0 | 65/0/1 |
| production-confirm | repair | `bun run test ./src/lib/runtime/attemptTempProduction.test.ts` | 0 | 65/0/1 |
| temporary-retention | repair | `bun run test ./src/lib/runtime/temporaryDataRetention.test.ts` | 0 | 69/0/0 |
| temporary-production | repair | `bun run test ./src/lib/runtime/temporaryDataProduction.test.ts` | 0 | 29/0/0 |
| liveness | repair | `bun run test ./src/lib/runtime/attemptTempRetention.liveness.test.ts` | 0 | 3/0/0 |
| binding | repair | `bun run test ./src/lib/runtime/attemptEvidenceBinding.test.ts` | 0 | 8/0/0 |
| gated-trash | repair | `bun run test ./src/lib/selfUpdate/gatedTrash.test.ts` | 0 | 17/0/0 |
| release-observer | repair | `bun run test ./src/lib/selfUpdate/releaseObserver.test.ts` | 0 | 8/0/0 |
| docker-cache | repair | `bun run test ./src/lib/dockerCacheRetention.test.ts` | 0 | 10/0/0 |
| test-safety | repair | `bun run test ./src/lib/retentionTestSafety.test.ts` | 0 | 6/0/0 |
| worktree-worker | repair | `bun run test ./src/lib/pipelines/worktreeSweepWorker.test.ts` | 0 | 38/0/0 |
| registry-temporary | repair | `bun run test ./src/lib/agent/registry.temporaryData.test.ts` | 0 | 3/0/0 |
| temp-cap | repair | `bun run test ./src/lib/tempSweep.cap.test.ts` | 0 | 1/0/0 |
| types | repair | `bunx --no-install tsc --noEmit` | 2 | — |
| copy-final | repair | `bun run test ./src/lib/runtime/temporaryDataProduction.recovery.test.ts` | 0 | 13/0/0 |
| types-final | repair | `bunx --no-install tsc --noEmit` | 0 | — |
| eslint | repair | `bun node_modules/eslint/bin/eslint.js scripts/temporary-data-dry-run.ts src/lib/agent/registry.temporaryData.test.ts src/lib/agent/registry.ts src/lib/agent/sqliteRegistryStore.ts src/lib/dockerCacheRetention.test.ts src/lib/dockerCacheRetention.ts src/lib/pipelines/worktreeSweep.fixture.ts src/lib/pipelines/worktreeSweepWorker.test.ts src/lib/pipelines/worktreeSweepWorker.ts src/lib/retention.worker.ts src/lib/retentionTestSafety.test.ts src/lib/retentionTestSafety.ts src/lib/runtime/attemptEvidenceBinding.test.ts src/lib/runtime/attemptEvidenceBinding.ts src/lib/runtime/attemptEvidenceCopies.ts src/lib/runtime/attemptMutationFence.test.ts src/lib/runtime/attemptMutationFence.ts src/lib/runtime/attemptTempDiagnostics.ts src/lib/runtime/attemptTempFilesystem.permissions.test.ts src/lib/runtime/attemptTempFilesystem.ts src/lib/runtime/attemptTempProduction.ts src/lib/runtime/attemptTempRetention.fixture.ts src/lib/runtime/attemptTempRetention.liveness.test.ts src/lib/runtime/attemptTempRetention.permissions.test.ts src/lib/runtime/attemptTempRetention.removalFences.test.ts src/lib/runtime/attemptTempRetention.test.ts src/lib/runtime/attemptTempRetention.ts src/lib/runtime/keepMarker.testSupport.ts src/lib/runtime/temporaryDataProduction.recovery.test.ts src/lib/runtime/temporaryDataProduction.test.ts src/lib/runtime/temporaryDataProduction.ts src/lib/runtime/temporaryDataRetention.fixture.ts src/lib/runtime/temporaryDataRetention.preservation.test.ts src/lib/runtime/temporaryDataRetention.test.ts src/lib/runtime/temporaryDataRetention.ts src/lib/runtime/temporaryDataStore.ts src/lib/selfUpdate/gatedTrash.test.ts src/lib/selfUpdate/releaseObserver.test.ts src/lib/selfUpdate/releaseObserver.worker.ts src/lib/selfUpdate/retention.test.ts src/lib/tempSweep.test.ts src/lib/tempSweep.ts src/lib/worktreeSweep.worker.ts` | 0 | — |

## Final readiness fence follow-up

Use the same private export procedure and explicit file commands above to repeat
these checks. Each recorded log belongs under the launch temporary root; retain
the completed log and exit receipt in stage evidence before that root expires.

Review of `bb85bd2aa5ccb920cb5a788dc67f9ddcb36ca53f` found an additional
late-preservation window inherited from #3943. After the real inotify read
returned EAGAIN, `mutationCurrent` polled only mountinfo. An independent writer
could complete a preservation record before that poll, leaving a queued event
that the final dispatch ignored on both fresh removal and journal replay.

The final zero-timeout poll now observes inotify POLLIN and mountinfo POLLPRI
together. Mount readiness, descriptor errors or a relevant queued event refuse
dispatch and restore the verified root through the existing fresh/replay
restoration paths. Newly queued unrelated names are drained in the existing
bounded loop before polling again. The new observation adds
one descriptor to the existing poll; no performance improvement is claimed.
There is no journal schema, permission-repair or removal-start contract change.
The shared consumer audit covers fresh trees, trash replay, temporary files,
the production sweep and its process fixtures.

Six cases in `src/lib/runtime/temporaryDataRetention.preservation.test.ts`
exercise fresh/replay removal with a late backup, an unrelated ancestor event,
or no late write. The tests wrap
the production dispatch callbacks, forward the real queue read, and wait for
a separate process to finish writing `worktree-backup.json` after EAGAIN.
They leave the native poll and remover intact. Refusal checks require the
original inode, payload, preservation record and ledger binding to survive,
with no trash or journal left behind. The controls require successful removal
and ledger settlement. Replay reopens the actual persistent store.

An initial diagnostic used caller stacks to find dispatch. It also reached
earlier validation calls, so its 2 pass / 2 fail result does not establish the
review's reproduction. Explicit callback wrapping replaces that ambiguous seam.

The first two-descriptor version conservatively refused every ready event. Its
full-file run gave 74 pass / 2 fail: two existing cases stopped before their
injection. The final version classifies newly queued names in the existing loop
and adds unrelated-write controls. With those same six new cases on unchanged
reviewed production, the full baseline gives 76 pass / 2 fail; only the fresh
and replay late-backup regressions fail. No older preservation assertion changed.

### Final fence command results

Each row ran through the launch-provided gate in private state. `GATE` names
that wrapper; `STAGE_SCRATCH` names the launch temporary root. The recorded
campaign uses supported parent-slot reuse: before each of its 25 child commands,
`bun "$(dirname "$GATE")/cpu-admission.ts" --reuse-slot` returned 0. Every child
then invoked `bash "$GATE" <command>` and had its own owned runner. No child
acquired a second slot. The 23 test files ran sequentially with fresh HOME,
XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, and a verified closed control endpoint.
Raw logs, complete arguments, start/end times, actual exit statuses and lease
observations are retained in stage evidence under `final-queue/`.

Final file totals: **876 pass / 0 fail / 25 opt-in skips**.
The skips remain the existing namespace and benchmark opt-ins. The source
and all 23 test-file digests match the verified export. The first two filtered
diagnostics each exclude the 72 older cases; those exclusions are not skips.

| Run | Command after gate | Exit | Pass/fail/skip |
| --- | --- | ---: | --- |
| queue-red | `bun run test ./src/lib/runtime/temporaryDataRetention.preservation.test.ts --test-name-pattern 'final queue readiness'` | 1 | 2/2/0 |
| queue-red-final | `bun run test ./src/lib/runtime/temporaryDataRetention.preservation.test.ts --test-name-pattern 'final queue readiness'` | 1 | 2/2/0 |
| final-00 | `bun run test ./src/lib/runtime/temporaryDataRetention.preservation.test.ts` | 1 | 74/2/0 |
| base-preservation | `bun run test ./src/lib/runtime/temporaryDataRetention.preservation.test.ts` | 1 | 76/2/0 |
| accept-00 | `bun run test ./src/lib/runtime/temporaryDataRetention.preservation.test.ts` | 0 | 78/0/0 |
| accept-01 | `bun run test ./src/lib/runtime/attemptTempRetention.permissions.test.ts` | 0 | 25/0/5 |
| accept-02 | `bun run test ./src/lib/runtime/temporaryDataProduction.recovery.test.ts` | 0 | 13/0/0 |
| accept-03 | `bun run test ./src/lib/tempSweep.test.ts` | 0 | 88/0/0 |
| accept-04 | `bun run test ./src/lib/runtime/temporaryDataRetention.test.ts` | 0 | 69/0/0 |
| accept-05 | `bun run test ./src/lib/selfUpdate/retention.test.ts` | 0 | 135/0/0 |
| accept-06 | `bun run test ./src/lib/runtime/attemptMutationFence.test.ts` | 0 | 17/0/0 |
| accept-07 | `bun run test ./src/lib/runtime/attemptTempRetention.removalFences.test.ts` | 0 | 25/0/0 |
| accept-08 | `bun run test ./src/lib/runtime/attemptTempRetention.test.ts` | 0 | 143/0/0 |
| accept-09 | `bun run test ./src/lib/runtime/attemptTempFilesystem.permissions.test.ts` | 0 | 27/0/5 |
| accept-10 | `bun run test ./src/lib/runtime/attemptTempFilesystem.test.ts` | 0 | 65/0/14 |
| accept-11 | `bun run test ./src/lib/runtime/attemptTempProduction.test.ts` | 0 | 65/0/1 |
| accept-12 | `bun run test ./src/lib/runtime/attemptCopyDiscovery.test.ts` | 0 | 3/0/0 |
| accept-13 | `bun run test ./src/lib/runtime/temporaryDataProduction.test.ts` | 0 | 29/0/0 |
| accept-14 | `bun run test ./src/lib/runtime/attemptTempRetention.liveness.test.ts` | 0 | 3/0/0 |
| accept-15 | `bun run test ./src/lib/runtime/attemptEvidenceBinding.test.ts` | 0 | 8/0/0 |
| accept-16 | `bun run test ./src/lib/selfUpdate/gatedTrash.test.ts` | 0 | 17/0/0 |
| accept-17 | `bun run test ./src/lib/selfUpdate/releaseObserver.test.ts` | 0 | 8/0/0 |
| accept-18 | `bun run test ./src/lib/dockerCacheRetention.test.ts` | 0 | 10/0/0 |
| accept-19 | `bun run test ./src/lib/retentionTestSafety.test.ts` | 0 | 6/0/0 |
| accept-20 | `bun run test ./src/lib/pipelines/worktreeSweepWorker.test.ts` | 0 | 38/0/0 |
| accept-21 | `bun run test ./src/lib/agent/registry.temporaryData.test.ts` | 0 | 3/0/0 |
| accept-22 | `bun run test ./src/lib/tempSweep.cap.test.ts` | 0 | 1/0/0 |
| types | `bunx --no-install tsc --noEmit` | 0 | — |
| eslint | `bun node_modules/eslint/bin/eslint.js scripts/temporary-data-dry-run.ts src/lib/agent/registry.temporaryData.test.ts src/lib/agent/registry.ts src/lib/agent/sqliteRegistryStore.ts src/lib/dockerCacheRetention.test.ts src/lib/dockerCacheRetention.ts src/lib/pipelines/worktreeSweep.fixture.ts src/lib/pipelines/worktreeSweepWorker.test.ts src/lib/pipelines/worktreeSweepWorker.ts src/lib/retention.worker.ts src/lib/retentionTestSafety.test.ts src/lib/retentionTestSafety.ts src/lib/runtime/attemptEvidenceBinding.test.ts src/lib/runtime/attemptEvidenceBinding.ts src/lib/runtime/attemptEvidenceCopies.ts src/lib/runtime/attemptMutationFence.test.ts src/lib/runtime/attemptMutationFence.ts src/lib/runtime/attemptTempDiagnostics.ts src/lib/runtime/attemptTempFilesystem.permissions.test.ts src/lib/runtime/attemptTempFilesystem.ts src/lib/runtime/attemptTempProduction.ts src/lib/runtime/attemptTempRetention.fixture.ts src/lib/runtime/attemptTempRetention.liveness.test.ts src/lib/runtime/attemptTempRetention.permissions.test.ts src/lib/runtime/attemptTempRetention.removalFences.test.ts src/lib/runtime/attemptTempRetention.test.ts src/lib/runtime/attemptTempRetention.ts src/lib/runtime/keepMarker.testSupport.ts src/lib/runtime/temporaryDataProduction.recovery.test.ts src/lib/runtime/temporaryDataProduction.test.ts src/lib/runtime/temporaryDataProduction.ts src/lib/runtime/temporaryDataRetention.fixture.ts src/lib/runtime/temporaryDataRetention.preservation.test.ts src/lib/runtime/temporaryDataRetention.test.ts src/lib/runtime/temporaryDataRetention.ts src/lib/runtime/temporaryDataStore.ts src/lib/selfUpdate/gatedTrash.test.ts src/lib/selfUpdate/releaseObserver.test.ts src/lib/selfUpdate/releaseObserver.worker.ts src/lib/selfUpdate/retention.test.ts src/lib/tempSweep.test.ts src/lib/tempSweep.ts src/lib/worktreeSweep.worker.ts` | 0 | — |

The captured-main comparisons for marker writers and transport above remain
applicable: 45 of the 48 inherited files are unchanged; the two production/test
changes here introduce no marker writer or hook change. Both reviewed heads
still pass `git merge-base --is-ancestor <reviewed-head> HEAD` (exit 0 each),
and `git ls-remote origin refs/heads/main` returned the same captured remote main
as the latest review. `git diff --check` returned 0 with zero whitespace errors.

The final types check exited 0 with zero diagnostics. ESLint checked 43 files,
exited 0, and reported zero errors and one existing unused-variable warning in
`src/lib/agent/registry.ts`. The final full-file privacy command selects all 48
branch files, including this report. The committed-history command checks additions,
messages and merge-boundary identities. Their retained records use `privacy-full`
and `privacy-head`; each must exit 0 with zero findings before stage completion.

| Run | Command after gate | Exit | Findings |
| --- | --- | ---: | ---: |
| privacy-full | `env LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json bun scripts/privacy-publication-gate.ts --repository "$WORKTREE" --require-known-values --paths docs/design/temporary-data-retention-operations.md docs/reports/temporary-data-retention-integration.md docs/reports/temporary-data-retention-validation.md scripts/delegatus-release-holders.py scripts/install-release-observer.py scripts/temporary-data-dry-run.ts src/lib/agent/registry.temporaryData.test.ts src/lib/agent/registry.ts src/lib/agent/sqliteRegistryStore.ts src/lib/dockerCacheRetention.test.ts src/lib/dockerCacheRetention.ts src/lib/pipelines/worktreeSweep.fixture.ts src/lib/pipelines/worktreeSweepWorker.test.ts src/lib/pipelines/worktreeSweepWorker.ts src/lib/retention.worker.ts src/lib/retentionTestSafety.test.ts src/lib/retentionTestSafety.ts src/lib/runtime/attemptEvidenceBinding.test.ts src/lib/runtime/attemptEvidenceBinding.ts src/lib/runtime/attemptEvidenceCopies.ts src/lib/runtime/attemptMutationFence.test.ts src/lib/runtime/attemptMutationFence.ts src/lib/runtime/attemptTempDiagnostics.ts src/lib/runtime/attemptTempFilesystem.permissions.test.ts src/lib/runtime/attemptTempFilesystem.ts src/lib/runtime/attemptTempProduction.ts src/lib/runtime/attemptTempRetention.fixture.ts src/lib/runtime/attemptTempRetention.liveness.test.ts src/lib/runtime/attemptTempRetention.permissions.test.ts src/lib/runtime/attemptTempRetention.removalFences.test.ts src/lib/runtime/attemptTempRetention.test.ts src/lib/runtime/attemptTempRetention.ts src/lib/runtime/keepMarker.testSupport.ts src/lib/runtime/temporaryDataProduction.recovery.test.ts src/lib/runtime/temporaryDataProduction.test.ts src/lib/runtime/temporaryDataProduction.ts src/lib/runtime/temporaryDataRetention.fixture.ts src/lib/runtime/temporaryDataRetention.preservation.test.ts src/lib/runtime/temporaryDataRetention.test.ts src/lib/runtime/temporaryDataRetention.ts src/lib/runtime/temporaryDataStore.ts src/lib/selfUpdate/gatedTrash.test.ts src/lib/selfUpdate/releaseObserver.test.ts src/lib/selfUpdate/releaseObserver.worker.ts src/lib/selfUpdate/retention.test.ts src/lib/tempSweep.test.ts src/lib/tempSweep.ts src/lib/worktreeSweep.worker.ts` | 0 | 0 |
| privacy-head | `env LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json bun scripts/privacy-publication-gate.ts --repository "$WORKTREE" --require-known-values --check-commits --added-lines --base ce7806df4acef79bbf76221943227e86c59863a9` | 0 | 0 |

A plain `git add` of the two retention files and this report, followed by a plain
`git commit`, records one repair commit with the configured stage hooks. Each
command exits 0. Post-commit source/digest and whitespace checks must remain
unchanged before handover; the commit and audit records are retained in stage
evidence. No push, deployment or live-root sweep is part of these checks.
