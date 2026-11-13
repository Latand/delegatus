# Temporary-data retention integration validation

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
`ded2c9588177eb76be7fece6906974508504b609`. The refreshed main stayed at that base.
Bun 1.4.0 executed the checks below.

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

## Final observations

The two required retention files pass 72/72 and 135/135. Every W4 file passes.
All 51 files selected by the repository's touched-file rule, plus copy discovery,
were run individually: 1,472 passes, 25 skips, three pre-existing failing assertions.
The repository comparator exits zero for both affected registry files, reporting
zero introduced failures and respectively one and two pre-existing assertions.
They concern nesting-policy fixture cleanup and capability-handover HTTP 403.
The namespace-dependent tests and opt-in benchmark account for the 25 skips.

The production build passed before reproduction. Subsequent implementation edits
changed tests and the reviewed test helper; production inputs still match the
built combined merge. W4's permission-refusal cases verify restored root/modes,
working consumer links, cleared intent and successful later retirement. The
preservation matrix verifies late records, payload bytes, inode identity and
replay; its unchanged controls still remove eligible trees.

## Command results

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
