# Delivery succession refresh verification

The refresh merges main `2614b079b3f174eb06bb65d9311460ea57aa6fee` into the delivery succession change with merge commit `0fd5fd47f17322dfa77f826561739aab903371c9`. Its first parent is `2e35906d5fabfbde119909d04ed8585182156bdf`; history is preserved.

Main advanced during validation to `a706416942a261300de13ed78c965cea75c1d202`. Its 34 changed files do not overlap the delivery change. `git merge-tree --write-tree HEAD origin/main` returned exit 0 and preview tree `ae4dc7954e0a56f627444e0062403f51be8a9e8f`. The test results below remain bound to the recorded merge commit and captured main revision.

The two conflicts in `src/lib/pipelines/store.ts` preserve main's merge withdrawal on close and active-owner takeover. Closing releases the delivery claim independently of host teardown. A running or uncertain publisher keeps its fence. Completed comparison takeover reads the closed owner from either collection and keeps an archived owner in the archive.

Review followed creation defaults and target copies in `createPipelineWithDelivery`, close persistence in `releaseTerminalDelivery`, takeover and recovery-history copies in `takeoverPipelineDelivery`, active/archive lookup, remote-action settlement, publication, merge withdrawal and the archive move. The archived-owner lookup consumes the bounded transaction budget and reads the existing row; takeover writes the successor and updates the old owner only if its row remains in the active pipeline collection.

Checks run under Bun 1.4.0 on Linux x86_64.

The tests use an export whose 8,008 tracked files were compared byte-for-byte with the merge commit. Dependencies are shared only after identical manifest, lockfile and patch inputs are verified. Every test command selects one explicit file and enters its own owned runner. Canonical test rows use `isolatedEnvironment` from `scripts/local-gate.ts`: fresh home, config, cache, account and state roots, `NODE_ENV=test`, and the Viewer control URL on closed loopback port 1. Native Git comes first in the test PATH. Failed files run again on the captured main revision with the same isolation. Test timeouts remain the project's 60 seconds, with explicit test-level deadlines respected.

`GATE` is the controller-provided installed `scripts/gate-slot.sh`. `EXPORT` is the indicated revision's source export. `SANDBOX` is fresh for every row. `RESULT` is that row's retained JUnit artifact. The command for a test row is:

```sh
cd "$EXPORT"
bash "$GATE" env HOME="$SANDBOX/home" XDG_CONFIG_HOME="$SANDBOX/xdg_config_home" \
  TMPDIR="$SANDBOX/tmpdir" LLV_STATE_DIR="$SANDBOX/llv_state_dir" LLV_GATE_RUNNER=off \
  NODE_ENV=test LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 PATH="/usr/bin:/bin:$PATH" \
  NO_COLOR=1 FORCE_COLOR=0 \
  bun run test "./$FILE" --reporter=junit --reporter-outfile="$RESULT"
```

The shell example shows the principal isolation values. The retained driver passes every changed or removed environment entry from the project helper, including its account roots and cleared launcher settings. The complete sequential driver runs through `gate-slot.sh --record` and is reconciled with `wait_for_check` through execution and cleanup. Driver completion is separate from individual command success. The ordinary owned execution allowance is 305 seconds per file; the additional full remote-action suite has 610 seconds to retain its known per-test timeout outcomes. CPU admission is recorded separately. The driver, configuration, ordered selection, source manifest, raw logs and JUnit reports are retained with the stage evidence.

The selection includes all 82 files from the project's touched-test plan, all 17 scoped Linux files, and three additional delivery/merge suites: `src/lib/pipelines/remoteActions.test.ts`, `src/lib/forge/autoMergeStore.test.ts` and `src/lib/forge/autoMerge.test.ts`.

An initial diagnostic driver isolated HOME, config, temporary and state roots but inherited `NODE_ENV=production` and a forge Git wrapper. It completed typecheck, lint, the Linux backend probe and 49 test commands before cancellation during the next file. Its recorder returned exit 143; the owned service was inactive and its reported child identities were absent before replacement. Those test observations remain diagnostic. The complete selection restarts with the project isolation helper and native Git; the initial receipts are retained separately.

The first standard-isolation recording reached its two-hour execution bound with 66 completed file receipts and exit 124. The interrupted `src/lib/pipelines/engine.providerBudgetPoolOutput.test.ts` command supplies no adopted verdict. Before continuing, the owned service was verified inactive, its reported process identities were absent, and all 8,008 tracked source files still matched the merge commit. The continuation selects the remaining 36 paths, beginning with a fresh run of the interrupted file, in new isolation directories.

Earlier implementation and review evidence remains in [verification.md](verification.md); its commands, revisions and limitations describe those historical runs.

## Check outcomes

Record assembled 2026-11-12T14:53:56+00:00. All 102 selected head files have complete reports. Initial standard-isolation head observations total **3563 pass, 54 fail, 12 skipped, 0 between-test errors**. The project parser and confirmation policy report **0 introduced failures, 52 pre-existing assertion failures and 2 flaky assertion occurrences**. One additional main-only failure passed on the head; that observation makes no causal claim about this change.

P/F/S/E means passed tests, failed tests (including failed hooks), skipped or filtered cases, and separately reported between-test errors. Assertion counts are Bun `expect()` calls. Primary rows preserve the first complete observation of each file. Full reruns below finish with 61/0 in the store file and 21/0 in the retry file.

The 16-case delivery regression passes on the head. Main plus the same regression file reports 9 pass and 7 fail, including the close/create/publish and archived-owner recovery paths. The archive case invokes the production archive move, settles takeover in a fresh controller process, verifies the passed SHA on the original bare-remote delivery branch, and verifies that the old owner stays out of the active collection.

### Non-test checks in the final isolation profile

| Receipt | Side | Command | Exit | P/F/S/E | Assertions |
| --- | --- | --- | ---: | ---: | ---: |
| types-final | head | `bunx tsc --noEmit` | 0 | — | — |
| lint-final | head | `bun run lint src/lib/pipelines/store.ts src/lib/pipelines/store.test.ts src/lib/pipelines/engine.ts src/lib/pipelines/deliverySuccession.test.ts src/lib/lifecycle/projector.ts src/lib/state/sqliteStateStore.ts` | 0 | — | — |
| linux-backend-final | head | `bun scripts/verify-platform-backend.ts --expect linux` | 0 | — | — |

Typecheck: exit 0, zero diagnostics. ESLint: six files, exit 0, zero errors and one existing `_waitMs` warning also present on the captured main. Linux backend: exit 0, four probes passed (backend selection, FFI, fence locking and first-boot fence creation). The typecheck execution allowance is 900 seconds.

### Every selected test file

The command is the single-file test command above, with the file in the first column. A main observation is required only for a failing head file. `main` here is the captured revision.

| File | Head exit | Head P/F/S/E | Main exit | Main P/F/S/E | Comparison |
| --- | ---: | ---: | ---: | ---: | --- |
| `src/lib/pipelines/deliverySuccession.test.ts` | 0 | 16/0/0/0 | — | — | pass |
| `src/lib/pipelines/store.test.ts` | 1 | 60/1/0/0 | 0 | 61/0/0/0 | 1 flaky |
| `src/lib/lifecycle/projector.test.ts` | 1 | 7/1/0/0 | 1 | 7/1/0/0 | 1 pre-existing |
| `src/lib/pipelines/engine.rolePrivacyEffects.test.ts` | 0 | 27/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.providerBudgetKinds.test.ts` | 0 | 28/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.providerBudgetPoolOutput.part3.test.ts` | 0 | 6/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.recoveryAuthority.part2.test.ts` | 0 | 86/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.providerBudget.test.ts` | 0 | 42/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.providerBudgetOutput.test.ts` | 0 | 5/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.recoveryAdmission.part2.test.ts` | 0 | 116/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.providerReset.part3.test.ts` | 0 | 27/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.provisioning.test.ts` | 0 | 73/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.mechanicalRecovery.test.ts` | 0 | 42/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.historyWrites.test.ts` | 0 | 10/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.succession.test.ts` | 0 | 32/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.creation.test.ts` | 0 | 113/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.missingWorktree.test.ts` | 0 | 35/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.roleMemoryDispatch.test.ts` | 0 | 110/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.recoveredPending.test.ts` | 0 | 43/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.containment.test.ts` | 0 | 55/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.closeAttempts.test.ts` | 0 | 50/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.controllerPass.test.ts` | 0 | 74/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.pauseMetadata.test.ts` | 0 | 19/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.settlementPreparation.test.ts` | 0 | 31/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.providerChains.test.ts` | 0 | 16/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.providerBudgetOutput.part2.test.ts` | 0 | 5/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.providerBudgetChains.part2.test.ts` | 0 | 18/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.recoveryAuthority.test.ts` | 0 | 98/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.controllerSnapshot.test.ts` | 0 | 2/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.succession.part3.test.ts` | 0 | 105/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.settlement.test.ts` | 0 | 121/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.accountGuard.test.ts` | 0 | 31/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.launchLease.test.ts` | 0 | 15/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.succession.part2.test.ts` | 0 | 99/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.cloud.test.ts` | 1 | 133/1/0/0 | 1 | 132/2/0/0 | 1 pre-existing; 1 main-only |
| `src/lib/pipelines/engine.claudeCloud.test.ts` | 0 | 11/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.providerBudgetChains.test.ts` | 0 | 18/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.accounting.test.ts` | 0 | 8/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.rolePrivacy.test.ts` | 0 | 20/0/1/0 | — | — | pass |
| `src/lib/pipelines/engine.proactive.part2.test.ts` | 1 | 50/2/0/0 | 1 | 50/2/0/0 | 2 pre-existing |
| `src/lib/pipelines/engine.suspendedRetry.test.ts` | 1 | 20/1/0/0 | 0 | 21/0/0/0 | 1 flaky |
| `src/lib/pipelines/engine.recoveryAdmission.test.ts` | 0 | 65/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.providerBudgetPoolOutput.part2.test.ts` | 0 | 5/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.providerBudgetOutput.part3.test.ts` | 0 | 6/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.spawnSilence.test.ts` | 0 | 25/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.recovery.part2.test.ts` | 0 | 85/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.terminalBudget.test.ts` | 0 | 11/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.spawnRetry.test.ts` | 0 | 103/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.routing.test.ts` | 1 | 99/8/0/0 | 1 | 99/8/0/0 | 8 pre-existing |
| `src/lib/pipelines/engine.fencedMessage.test.ts` | 0 | 24/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.activation.test.ts` | 1 | 52/1/0/0 | 1 | 52/1/0/0 | 1 pre-existing |
| `src/lib/pipelines/engine.providerBudgetChains.part3.test.ts` | 0 | 26/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.cpuQueue.test.ts` | 0 | 2/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.dependencies.test.ts` | 0 | 4/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.rolePrivacyEffects.part2.test.ts` | 0 | 26/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.restoreContinuation.test.ts` | 0 | 78/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.providerReset.test.ts` | 0 | 18/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.providerSignals.test.ts` | 0 | 28/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.ports.part2.test.ts` | 0 | 51/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.proactive.test.ts` | 0 | 41/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.settlementAuthority.test.ts` | 0 | 1/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.recovery.test.ts` | 0 | 67/0/1/0 | — | — | pass |
| `src/lib/pipelines/engine.providerReset.part2.test.ts` | 0 | 5/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.capacity.test.ts` | 0 | 25/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.ports.part3.test.ts` | 0 | 18/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.watchdogRegression.test.ts` | 0 | 5/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.providerBudgetPoolOutput.test.ts` | 0 | 5/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.providerChains.part2.test.ts` | 0 | 32/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.publication.test.ts` | 0 | 36/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.setupRecipe.test.ts` | 0 | 7/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.cpuAdmissionPolling.test.ts` | 0 | 15/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.rolePrivacyEffects.part3.test.ts` | 0 | 26/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.privacyCorrelation.test.ts` | 0 | 1/0/0/0 | — | — | pass |
| `src/lib/pipelines/engine.ports.test.ts` | 0 | 81/0/0/0 | — | — | pass |
| `src/lib/pipelines/store.cooperativeFreeze.test.ts` | 0 | 2/0/0/0 | — | — | pass |
| `src/lib/pipelines/store.reads.test.ts` | 0 | 4/0/0/0 | — | — | pass |
| `src/lib/pipelines/store.archiveText.test.ts` | 0 | 3/0/0/0 | — | — | pass |
| `src/lib/pipelines/store.schemaCompatibility.test.ts` | 0 | 13/0/0/0 | — | — | pass |
| `src/lib/state/sqliteStateStore.readCache.test.ts` | 0 | 16/0/0/0 | — | — | pass |
| `src/lib/state/sqliteStateStore.deferredText.test.ts` | 0 | 8/0/0/0 | — | — | pass |
| `src/lib/state/sqliteStateStore.bounded.test.ts` | 0 | 25/0/0/0 | — | — | pass |
| `src/lib/state/sqliteStateStore.lifecycle.test.ts` | 0 | 5/0/0/0 | — | — | pass |
| `src/lib/proc/memory.test.ts` | 0 | 17/0/0/0 | — | — | pass |
| `src/lib/proc/portable.test.ts` | 0 | 1/0/0/0 | — | — | pass |
| `src/lib/proc/darwinIdentity.test.ts` | 0 | 3/0/0/0 | — | — | pass |
| `src/lib/proc/index.test.ts` | 0 | 6/0/0/0 | — | — | pass |
| `src/lib/proc/windowsSnapshot.test.ts` | 0 | 14/0/0/0 | — | — | pass |
| `src/lib/proc/windowsIdentity.test.ts` | 0 | 6/0/1/0 | — | — | pass |
| `src/lib/proc/windowsCwd.test.ts` | 0 | 3/0/0/0 | — | — | pass |
| `src/lib/proc/windows.test.ts` | 0 | 16/0/5/0 | — | — | pass |
| `src/lib/processGroup.test.ts` | 0 | 15/0/2/0 | — | — | pass |
| `src/lib/platformHome.test.ts` | 0 | 5/0/0/0 | — | — | pass |
| `src/lib/runtime/localEndpoint.test.ts` | 0 | 5/0/0/0 | — | — | pass |
| `src/lib/scanner/describe.test.ts` | 0 | 59/0/2/0 | — | — | pass |
| `src/lib/state/durableJson.test.ts` | 0 | 6/0/0/0 | — | — | pass |
| `src/runtime-host/socket.test.ts` | 0 | 7/0/0/0 | — | — | pass |
| `src/runtime-host/runtimeHostFence.test.ts` | 0 | 6/0/0/0 | — | — | pass |
| `bin/server-runtime.test.ts` | 0 | 31/0/0/0 | — | — | pass |
| `bin/bind-guard.test.ts` | 0 | 15/0/0/0 | — | — | pass |
| `src/lib/pipelines/remoteActions.test.ts` | 1 | 1/39/0/0 | 1 | 1/39/0/0 | 39 pre-existing |
| `src/lib/forge/autoMergeStore.test.ts` | 0 | 146/0/0/0 | — | — | pass |
| `src/lib/forge/autoMerge.test.ts` | 0 | 175/0/0/0 | — | — | pass |

### Main controls

| Receipt | Side | Command | Exit | P/F/S/E | Assertions |
| --- | --- | --- | ---: | ---: | ---: |
| native-git-main-control | base | `bun run test ./src/lib/pipelines/engine.provisioning.test.ts` | 0 | 73/0/0/0 | 388 |
| main-with-regression | base | `bun run test ./src/lib/pipelines/deliverySuccession.test.ts` | 1 | 9/7/0/0 | 175 |

The provisioning control uses native Git and passes all 73 cases on both revisions. The initial diagnostic environment inherited a forge Git wrapper which its restricted-PATH fixture could not use. The main-with-regression row uses a separate main export with only the head regression file copied into it.

### Fresh confirmations and full-file reruns

| Receipt | Side | Command | Exit | P/F/S/E | Assertions |
| --- | --- | --- | ---: | ---: | ---: |
| store-head-1 | head | `bun run test ./src/lib/pipelines/store.test.ts -t '^promoted Viewer loads historical severity-only verdicts before hot-state activation$'` | 0 | 1/0/60/0 | 3 |
| store-base-1 | base | `bun run test ./src/lib/pipelines/store.test.ts -t '^promoted Viewer loads historical severity-only verdicts before hot-state activation$'` | 0 | 1/0/60/0 | 3 |
| store-head-2 | head | `bun run test ./src/lib/pipelines/store.test.ts -t '^promoted Viewer loads historical severity-only verdicts before hot-state activation$'` | 0 | 1/0/60/0 | 3 |
| store-base-2 | base | `bun run test ./src/lib/pipelines/store.test.ts -t '^promoted Viewer loads historical severity-only verdicts before hot-state activation$'` | 0 | 1/0/60/0 | 3 |
| store-head-3 | head | `bun run test ./src/lib/pipelines/store.test.ts -t '^promoted Viewer loads historical severity-only verdicts before hot-state activation$'` | 0 | 1/0/60/0 | 3 |
| store-base-3 | base | `bun run test ./src/lib/pipelines/store.test.ts -t '^promoted Viewer loads historical severity-only verdicts before hot-state activation$'` | 0 | 1/0/60/0 | 3 |
| store-head-full | head | `bun run test ./src/lib/pipelines/store.test.ts` | 0 | 61/0/0/0 | 387 |
| retry-head-1 | head | `bun run test ./src/lib/pipelines/engine.suspendedRetry.test.ts -t '^a fresh controller consumes a pending explicit retry from the persisted stage definition, changed=%s$'` | 0 | 2/0/19/0 | 20 |
| retry-base-1 | base | `bun run test ./src/lib/pipelines/engine.suspendedRetry.test.ts -t '^a fresh controller consumes a pending explicit retry from the persisted stage definition, changed=%s$'` | 0 | 2/0/19/0 | 20 |
| retry-head-2 | head | `bun run test ./src/lib/pipelines/engine.suspendedRetry.test.ts -t '^a fresh controller consumes a pending explicit retry from the persisted stage definition, changed=%s$'` | 0 | 2/0/19/0 | 20 |
| retry-base-2 | base | `bun run test ./src/lib/pipelines/engine.suspendedRetry.test.ts -t '^a fresh controller consumes a pending explicit retry from the persisted stage definition, changed=%s$'` | 0 | 2/0/19/0 | 20 |
| retry-head-3 | head | `bun run test ./src/lib/pipelines/engine.suspendedRetry.test.ts -t '^a fresh controller consumes a pending explicit retry from the persisted stage definition, changed=%s$'` | 0 | 2/0/19/0 | 20 |
| retry-base-3 | base | `bun run test ./src/lib/pipelines/engine.suspendedRetry.test.ts -t '^a fresh controller consumes a pending explicit retry from the persisted stage definition, changed=%s$'` | 0 | 2/0/19/0 | 20 |
| retry-head-full | head | `bun run test ./src/lib/pipelines/engine.suspendedRetry.test.ts` | 0 | 21/0/0/0 | 193 |

The two first-sample failures expected an empty child stderr. The children exited 0 and emitted successful lock-wait diagnostics. Each assertion passed in three fresh head/main pairs. The retry filter covers both duplicate parameterized test occurrences; all six head and six main parameterized observations passed. Both complete head files then passed. The project `confirmFailures` function retires these two occurrences as flaky.

### Named pre-existing assertions

`src/lib/lifecycle/projector.test.ts`:

- pausing and resuming a pipeline through the real action emits stage_paused and stage_resumed (#686)

`src/lib/pipelines/engine.cloud.test.ts`:

- the Cloud runtime enforces the remaining stage deadline: expired=false size=70000

`src/lib/pipelines/engine.proactive.part2.test.ts`:

- unadopted merge custody survives restart: head-changed
- unadopted merge custody survives restart: review-changed

`src/lib/pipelines/engine.routing.test.ts`:

- a stage conversation switched to another account continues on the message held for the switch and settles on the successor's verdict without the fail edge (#1695 K6c)
- a replaced attempt names its cause when no restart happened: dead
- a replaced attempt names its cause when no restart happened: idle
- a replaced attempt names its cause when no restart happened: stalled
- a stage that keeps working after its turn ended keeps its host through the recovery tick and the deferred cursor write
- a descendant that outlives the runtime's release is still signalled, and the attempt is replaced
- an attempt that worked on after a restart and is stopped for silence later is not called a restart
- an attempt that worked on after a restart and whose host is found gone later is not called a restart

`src/lib/pipelines/engine.activation.test.ts`:

- an internal terminal pass an older build left waiting on publication closes without the network (#1692)

`src/lib/pipelines/remoteActions.test.ts`:

- skip-stage durably acknowledges before its fenced Git check (success)
- skip-stage durably acknowledges before its fenced Git check (failure)
- skip-stage durably acknowledges before its fenced Git check (pause)
- skip-stage durably acknowledges before its fenced Git check (owner)
- a deferred skip preserves output ownership when paused before-write
- a deferred skip preserves output ownership when paused after-write
- compact MCP polling exposes a deferred publication failure while preserving operator detail
- launch artifact work yields the pipeline lease to a newer pause
- a controller output commit survives pause before durable adoption
- a controller output commit survives lost-reply before durable adoption
- an accepted publication settles a unsupported locking refusal in the controller and journal
- an accepted publication settles a unopenable locking refusal in the controller and journal
- a blocked artifact parent produces a visible action refusal
- a blocked artifact parent produces a visible stage refusal
- an old publication lock refusal preserves a newer reservation and lane detail
- a queued publication is superseded by pause even after same-clock resume (%s)
- a queued publication is superseded by pause even after same-clock resume (%s) (occurrence 2)
- a same-clock pause and resume during one remote probe supersedes its retry
- review retry records pending intent before flow teardown and yields its lease
- a cancelled takeover preserves a newer pause and its detail
- takeover settlement survives restart after the ownership transaction (paused afterward: %s)
- takeover settlement survives restart after the ownership transaction (paused afterward: %s) (occurrence 2)
- explicit publication retries a settled probe failure and preserves pending admission
- explicit publication retries a settled push failure and preserves pending admission
- legacy publication records acceptance before observing its missing delivery claim
- a passed-stage retry acknowledges before checking its accepted local head
- a routine mutation acknowledges an existing queued publication without executing Git
- unsupported inherited locks settle visibly before any Git command
- superseded stage Git leaves the current task note untouched
- review flow identity Git yields to a pause before the controller lease
- local committing stages progress with Git available and no flock utility
- a remote review retry records pending work before remote Git answers
- durable retry intent settles after a fresh controller loads it
- a paused lane cancels a remote check and preserves the pause
- another pending action is refused before it can replace an admitted retry
- remote failure settles visibly without launching a review
- a receipt that settles during remote verification cancels its retry
- controller review Git does not hold the MCP mutation lease
- controller build Git does not hold the MCP mutation lease

### Recorder and diagnostic history

Each recorder was started once with `bash "$GATE" --record "$LOG" python3 "$PROCEDURE" "$CONFIG"`, with the execution allowance below, then reconciled once through `wait_for_check`. The procedures and logs are retained with the stage.

| Recording | Procedure | Allowance | Driver exit | Completed commands |
| --- | --- | ---: | ---: | ---: |
| refresh-verification | `campaign.py` | 7200000 ms | 143 | 52 |
| refresh-canonical | `canonical.py` | 7200000 ms | 124 | 73 |
| refresh-continuation | `continuation.py` | 7200000 ms | 0 | 39 |
| refresh-confirmation | `confirmation.py` | 3600000 ms | 1 | 3 |
| refresh-confirmation-v2 | `confirmation-v2.py` | 3600000 ms | 0 | 14 |

The first confirmation recorder completed its three non-test checks, then a bookkeeping exception occurred after the first filtered store command returned. Its per-command gate status was not written, so that probe supplies no adopted verdict. The corrected procedure uses a fresh directory and avoids shadowing the numeric rounding function with its loop counter. Its complete confirmation cohort is reported above.

The cancelled diagnostic recording interrupted `bun run test ./src/lib/pipelines/engine.recovery.part2.test.ts`; its per-file exit and counts are unknown. The execution-bounded recording interrupted `bun run test ./src/lib/pipelines/engine.providerBudgetPoolOutput.test.ts`; its per-file exit and counts are unknown. Both paths have complete later observations. The completed initial diagnostic commands follow; these test results are separate from the standard-isolation verdict. Their HOME/config/tmp/state directories used `home`, `config`, `tmp`, and `state` under each fresh sandbox.

| Receipt | Side | Command | Exit | P/F/S/E | Assertions |
| --- | --- | --- | ---: | ---: | ---: |
| head-types | head | `bunx tsc --noEmit` | 0 | — | — |
| head-lint | head | `bun run lint src/lib/pipelines/store.ts src/lib/pipelines/store.test.ts src/lib/pipelines/engine.ts src/lib/pipelines/deliverySuccession.test.ts src/lib/lifecycle/projector.ts src/lib/state/sqliteStateStore.ts` | 0 | — | — |
| head-linux-backend | head | `bun scripts/verify-platform-backend.ts --expect linux` | 0 | — | — |
| 000-head | head | `bun run test ./src/lib/pipelines/deliverySuccession.test.ts` | 0 | 16/0/0/0 | 198 |
| 001-head | head | `bun run test ./src/lib/pipelines/store.test.ts` | 0 | 61/0/0/0 | 384 |
| 002-head | head | `bun run test ./src/lib/lifecycle/projector.test.ts` | 1 | 7/1/0/0 | 29 |
| 002-base | base | `bun run test ./src/lib/lifecycle/projector.test.ts` | 1 | 7/1/0/0 | 29 |
| 003-head | head | `bun run test ./src/lib/pipelines/engine.rolePrivacyEffects.test.ts` | 0 | 27/0/0/0 | 27 |
| 004-head | head | `bun run test ./src/lib/pipelines/engine.providerBudgetKinds.test.ts` | 0 | 28/0/0/0 | 147 |
| 005-head | head | `bun run test ./src/lib/pipelines/engine.providerBudgetPoolOutput.part3.test.ts` | 0 | 6/0/0/0 | 18 |
| 006-head | head | `bun run test ./src/lib/pipelines/engine.recoveryAuthority.part2.test.ts` | 0 | 86/0/0/0 | 478 |
| 007-head | head | `bun run test ./src/lib/pipelines/engine.providerBudget.test.ts` | 0 | 42/0/0/0 | 172 |
| 008-head | head | `bun run test ./src/lib/pipelines/engine.providerBudgetOutput.test.ts` | 0 | 5/0/0/0 | 15 |
| 009-head | head | `bun run test ./src/lib/pipelines/engine.recoveryAdmission.part2.test.ts` | 0 | 116/0/0/0 | 306 |
| 010-head | head | `bun run test ./src/lib/pipelines/engine.providerReset.part3.test.ts` | 0 | 27/0/0/0 | 177 |
| 011-head | head | `bun run test ./src/lib/pipelines/engine.provisioning.test.ts` | 1 | 70/4/0/3 | 377 |
| 011-base | base | `bun run test ./src/lib/pipelines/engine.provisioning.test.ts` | 1 | 70/4/0/3 | 377 |
| 012-head | head | `bun run test ./src/lib/pipelines/engine.mechanicalRecovery.test.ts` | 0 | 42/0/0/0 | 822 |
| 013-head | head | `bun run test ./src/lib/pipelines/engine.historyWrites.test.ts` | 0 | 10/0/0/0 | 108 |
| 014-head | head | `bun run test ./src/lib/pipelines/engine.succession.test.ts` | 0 | 32/0/0/0 | 149 |
| 015-head | head | `bun run test ./src/lib/pipelines/engine.creation.test.ts` | 0 | 113/0/0/0 | 722 |
| 016-head | head | `bun run test ./src/lib/pipelines/engine.missingWorktree.test.ts` | 0 | 35/0/0/0 | 352 |
| 017-head | head | `bun run test ./src/lib/pipelines/engine.roleMemoryDispatch.test.ts` | 0 | 110/0/0/0 | 1155 |
| 018-head | head | `bun run test ./src/lib/pipelines/engine.recoveredPending.test.ts` | 0 | 43/0/0/0 | 622 |
| 019-head | head | `bun run test ./src/lib/pipelines/engine.containment.test.ts` | 0 | 55/0/0/0 | 402 |
| 020-head | head | `bun run test ./src/lib/pipelines/engine.closeAttempts.test.ts` | 0 | 50/0/0/0 | 323 |
| 021-head | head | `bun run test ./src/lib/pipelines/engine.controllerPass.test.ts` | 1 | 71/3/0/0 | 542 |
| 021-base | base | `bun run test ./src/lib/pipelines/engine.controllerPass.test.ts` | 1 | 71/3/0/0 | 542 |
| 022-head | head | `bun run test ./src/lib/pipelines/engine.pauseMetadata.test.ts` | 0 | 19/0/0/0 | 47 |
| 023-head | head | `bun run test ./src/lib/pipelines/engine.settlementPreparation.test.ts` | 0 | 31/0/0/0 | 544 |
| 024-head | head | `bun run test ./src/lib/pipelines/engine.providerChains.test.ts` | 0 | 16/0/0/0 | 96 |
| 025-head | head | `bun run test ./src/lib/pipelines/engine.providerBudgetOutput.part2.test.ts` | 0 | 5/0/0/0 | 15 |
| 026-head | head | `bun run test ./src/lib/pipelines/engine.providerBudgetChains.part2.test.ts` | 0 | 18/0/0/0 | 82 |
| 027-head | head | `bun run test ./src/lib/pipelines/engine.recoveryAuthority.test.ts` | 0 | 98/0/0/0 | 388 |
| 028-head | head | `bun run test ./src/lib/pipelines/engine.controllerSnapshot.test.ts` | 0 | 2/0/0/0 | 7 |
| 029-head | head | `bun run test ./src/lib/pipelines/engine.succession.part3.test.ts` | 0 | 105/0/0/0 | 530 |
| 030-head | head | `bun run test ./src/lib/pipelines/engine.settlement.test.ts` | 0 | 121/0/0/0 | 1016 |
| 031-head | head | `bun run test ./src/lib/pipelines/engine.accountGuard.test.ts` | 0 | 31/0/0/0 | 161 |
| 032-head | head | `bun run test ./src/lib/pipelines/engine.launchLease.test.ts` | 0 | 15/0/0/0 | 15 |
| 033-head | head | `bun run test ./src/lib/pipelines/engine.succession.part2.test.ts` | 0 | 99/0/0/0 | 651 |
| 034-head | head | `bun run test ./src/lib/pipelines/engine.cloud.test.ts` | 0 | 134/0/0/0 | 1301 |
| 035-head | head | `bun run test ./src/lib/pipelines/engine.claudeCloud.test.ts` | 0 | 11/0/0/0 | 93 |
| 036-head | head | `bun run test ./src/lib/pipelines/engine.providerBudgetChains.test.ts` | 0 | 18/0/0/0 | 82 |
| 037-head | head | `bun run test ./src/lib/pipelines/engine.accounting.test.ts` | 0 | 8/0/0/0 | 66 |
| 038-head | head | `bun run test ./src/lib/pipelines/engine.rolePrivacy.test.ts` | 0 | 20/0/1/0 | 178 |
| 039-head | head | `bun run test ./src/lib/pipelines/engine.proactive.part2.test.ts` | 1 | 50/2/0/0 | 445 |
| 039-base | base | `bun run test ./src/lib/pipelines/engine.proactive.part2.test.ts` | 1 | 50/2/0/0 | 445 |
| 040-head | head | `bun run test ./src/lib/pipelines/engine.suspendedRetry.test.ts` | 0 | 21/0/0/0 | 193 |
| 041-head | head | `bun run test ./src/lib/pipelines/engine.recoveryAdmission.test.ts` | 0 | 65/0/0/0 | 411 |
| 042-head | head | `bun run test ./src/lib/pipelines/engine.providerBudgetPoolOutput.part2.test.ts` | 0 | 5/0/0/0 | 15 |
| 043-head | head | `bun run test ./src/lib/pipelines/engine.providerBudgetOutput.part3.test.ts` | 0 | 6/0/0/0 | 18 |
| 044-head | head | `bun run test ./src/lib/pipelines/engine.spawnSilence.test.ts` | 0 | 25/0/0/0 | 132 |

### Additional verification and publication procedure

- Plain merge commit hook: exit 0; staged whitespace clean; ESLint covered 43 lintable files with zero introduced errors.
- `git diff --check`: exit 0, zero whitespace errors.
- Python tracked-byte comparison against the head export and `git archive` of main: exit 0; 8,008 head files and 8,006 main files compared, zero differences.
- Project report parsing and `confirmFailures` aggregation: exit 0; 102/102 file reports validated, zero introduced failures, 52 pre-existing occurrences, two flaky occurrences.
- The later evidence commit adds only this Markdown record; application source and test bytes remain those of the tested merge.

The handoff records the actual publication privacy verdict after the evidence text is finalized. The commands use the committed known-value fingerprints and an isolated state root:

```sh
LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json \
  bun scripts/privacy-publication-gate.ts --base "$BASE" --require-known-values \
  --paths evidence/delivery-succession/verification.md evidence/delivery-succession/refresh.md \
  src/lib/lifecycle/projector.ts src/lib/pipelines/deliverySuccession.test.ts \
  src/lib/pipelines/engine.ts src/lib/pipelines/store.test.ts src/lib/pipelines/store.ts \
  src/lib/state/sqliteStateStore.ts

LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json \
  bun scripts/privacy-publication-gate.ts --repository "$WORKTREE" --base "$BASE" \
  --require-known-values --check-commits --added-lines
```
