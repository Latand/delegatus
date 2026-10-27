# Registry write caller map

The original L7 map was made **before editing**, against `c10380df`.
The serving-caller completion below extends `6cefc45bc`. Original caller-table
locations and counts remain pinned to `c10380df`; find later code by method name. The inventory
follows `this.mutateStorage` backwards through the `AgentRegistry` methods and
resolves external call signatures with TypeScript. Test modules are excluded;
benchmark and child-fixture consumers are explicitly classified below.

## Wait producers

| Site | Producer | Consumers and behavior |
| --- | --- | --- |
| `registry-lock` | `SqliteAgentRegistryStore.mutate` → `beginMutationWrite` → `noteWriterWait` | Legacy synchronous acquisition; optimistic acquisition followed by a pessimistic retry |
| `registry-revision-retry` | `SqliteAgentRegistryStore.mutate` after a lost optimistic revision | Rolls back and retries under the writer, with the existing retry ceiling. Account-held zero-wait probes report `synchronous: false`. |
| `registry-lock-async` | `withWriter` / `tryWriter` via `AgentRegistry.deliveryWrite*`, and account-held zero-wait mutation probes | Held-writer callbacks read the admitted revision. Mixed account/state callbacks release the SQLite probe before sibling writes and retry contention outside account custody. Their SQLite busy timeout is zero. |

Direct store mutations outside `AgentRegistry` are synthetic preparation in
`src/runtime-host/candidatePerformanceRun.ts`, dataset builders, benchmarks and
isolated child fixtures. Those execute outside the serving Viewer loop.
The registry-open path and the L8/L10 source files are unchanged.

The minified `subject` alone cannot identify a mutation. Join `role`, `site`,
`callSite` and the profiler's **file, line and column**, on the same serving
revision. A function name or line alone is ambiguous. `registryWaitCallSite`
retains source/compiled coordinates while stripping private prefixes. This
source inventory does not invent a historical minified-name mapping from
records that lack those coordinates. New admissions carry stable
`registry.<method>` labels and register as `registry.write` in the loop monitor.

## Callers

TypeScript resolved 387 external calls to 154 transitively mutating methods (including private helpers).

| Source | Methods and pinned lines | Admission |
| --- | --- | --- |
| `scripts/benchmark-viewer-workers.ts` | `reconcileConversations` :50 | separate benchmark/fixture process; synchronous API retained |
| `scripts/capture-board-geometry.ts` | `recordQuotaEvaluation` :2549; `recordQuotaEvaluation` :2554 | separate benchmark/fixture process; synchronous API retained |
| `scripts/mcp-call-cost-benchmark.ts` | `rotateSpawnCapabilityForReceipt` :147; `settleSpawn` :342; `rotateSpawnCapabilityForReceipt` :344 | separate benchmark/fixture process; synchronous API retained |
| `scripts/mcp-memory-benchmark.ts` | `beginSpawn` :114; `settleSpawn` :115; `rotateSpawnCapabilityForReceipt` :133 | separate benchmark/fixture process; synchronous API retained |
| `scripts/mcp-state-writer-benchmark.ts` | `rotateSpawnCapabilityForReceipt` :61 | separate benchmark/fixture process; synchronous API retained |
| `scripts/measure-registry-guard.ts` | `beginSpawnRequest` :45; `releaseStartingStructuredSpawn` :47; `failStructuredSpawn` :48 | separate benchmark/fixture process; synchronous API retained |
| `scripts/readme-demo-state.ts` | `recordQuotaEvaluation` :625; `recordQuotaEvaluation` :633 | separate benchmark/fixture process; synchronous API retained |
| `scripts/registry-write-benchmark.ts` | `compactDeliveryReservations` :129; `compactDeliveryReservations` :175 | existing admission |
| `scripts/registry-write-benchmark.ts` | `ensureConversation` :157; `holdDelivery` :158; `recordDeliveryOutcome` :160 | separate benchmark/fixture process; synchronous API retained |
| `scripts/runtime-delivery-benchmark.ts` | `reconcileConversations` :63; `upsert` :70 | separate benchmark/fixture process; synchronous API retained |
| `scripts/startup-retry-benchmark.ts` | `reconcileConversations` :40; `upsert` :42 | separate benchmark/fixture process; synchronous API retained |
| `src/app/api/account-migrations/[intentId]/action.ts` | `setMigrationIntentState` :30; `retryConversationMigration` :47 | existing admission |
| `src/app/api/accounts/claude/policy/route.ts` | `setAutoBalancePolicy` :14 | async admission in L7 |
| `src/app/api/accounts/codex/policy/route.ts` | `setAutoBalancePolicy` :14 | async admission in L7 |
| `src/app/api/runtime/hosts/route.ts` | `recordStructuredTerminationSurvivors` :77 | admitted boundary; see serving-caller completion |
| `src/app/api/session/supersedence/route.ts` | `clearSupersedence` :39 | async admission in L7 |
| `src/app/api/tasks/[id]/spawn/route.ts` | `claimTmuxSpawnActuation` :408; `settleSpawn` :476; `markSpawnPathPending` :490; `markSpawnPathPending` :496 | async admission in L7 |
| `src/app/api/tasks/[id]/spawn/route.ts` | `beginSpawnRequestAsync` :355; `failSpawnOffLoop` :434; `failSpawnOffLoop` :439; `failSpawnOffLoop` :449; `failSpawnOffLoop` :512 | existing admission |
| `src/lib/accounts/liveLimits.ts` | `recordQuotaObservation` :65 | production uses recordLiveObservationOffLoop in L7 |
| `src/lib/accounts/manager.ts` | `setEngineRouting` :547; `setEngineRouting` :552 | admitted boundary; see serving-caller completion |
| `src/lib/accounts/migration/conversationCommand.ts` | `requestConversationReseat` :223; `withdrawConversationReconfigure` :274; `releaseSwitchHold` :304; `cancelConversationSwitch` :323; `rollbackConversationMigration` :343; `retryConversationMigration` :369 | existing admission |
| `src/lib/accounts/migration/coordinator.ts` | `reconcileConversations` :574; `reconcileConversations` :578; `commitMigrationIntent` :624 | async admission in L7 |
| `src/lib/accounts/migration/coordinator.ts` | `reconcileConversations` :573; `markMigrationBoardPlacementProjects` :865; `markMigrationBoardProjects` :895; `completeSuccessorCleanup` :919; `queueSuccessorCleanup` :926; `completeSuccessorCleanup` :931; `recordSuccessorCleanupFailure` :934; `recordMigrationContinuityPath` :1113; `persistMigrationProviderReceipt` :1119; `commitSuccessor` :1207; `recordDeliveryOutcome` :1292; `beginDeliveryAttempt` :1308; `recordDeliveryOutcome` :1332; `recordDeliveryOutcome` :1346; `requeueUnactuatedDelivery` :1347; `recordDeliveryOutcome` :1351; `recordDeliveryOutcome` :1355; `terminalizeOrphanedHeldDelivery` :1462; `terminalizeRolledBackMigrationDelivery` :1481; `rollbackConversationMigration` :1512; `recordAutoBalanceOutcome` :1610; `setMigrationIntentState` :1612 | existing admission |
| `src/lib/accounts/migration/coordinator.ts` | `transitionConversationMigration` :1012; `transitionConversationMigration` :1041; `rollbackConversationMigration` :1061; `transitionConversationMigration` :1068; `transitionConversationMigration` :1074; `transitionConversationMigration` :1087; `transitionConversationMigration` :1259 | admitted boundary; see serving-caller completion |
| `src/lib/accounts/migration/provider.ts` | `upsert` :316; `setStructuredHost` :333; `claimStructuredHost` :346; `releaseStructuredHostClaim` :368; `releaseStructuredHostClaim` :425; `upsert` :459; `setStructuredHost` :476; `claimStructuredHost` :489; `releaseStructuredHostClaim` :507; `releaseStructuredHostClaim` :578; `discardSpawnCapabilityForOperation` :1559 | async admission in L7 |
| `src/lib/accounts/migration/provider.ts` | `stageSpawnCapabilityForConversation` :268; `discardSpawnCapabilityForOperation` :275 | admitted boundary; see serving-caller completion |
| `src/lib/accounts/migration/quotaController.ts` | `recordQuotaObservation` :352; `recordQuotaEvaluation` :359 | combined account/registry admission in L7 |
| `src/lib/accounts/removal.ts` | `restoreSnapshot` :580; `restoreSnapshot` :887; `rewriteAccountPaths` :979 | existing admission |
| `src/lib/accounts/removal.ts` | `retireAccountNow` :567; `retireAccountNow` :870; `retireAccountNow` :964 | existing single probe |
| `src/lib/agent/identityWaveStartup.ts` | `runIdentityWaveMigration` :189 | admitted boundary; see serving-caller completion |
| `src/lib/agent/registry.sqliteChild.ts` | `ensureConversation` :40; `ensureConversation` :50; `upsert` :81; `claimStructuredHost` :85; `setStructuredHostClaimed` :94; `ensureConversation` :104 | separate benchmark/fixture process; synchronous API retained |
| `src/lib/agent/spawnCommand.ts` | `queuePinnedSpawn` :1194; `claimStartingStructuredSpawn` :1352; `releaseStartingStructuredSpawn` :1361; `releaseSpawnActuation` :1377; `releaseSpawnActuation` :1389; `invalidateSpawnHost` :1449; `markSpawnPathPending` :1454; `settleSpawn` :1457; `invalidateSpawnHost` :1493; `markSpawnPathPending` :1532 | async admission in L7 |
| `src/lib/agent/spawnCommand.ts` | `beginSpawnRequestAsync` :876; `failStructuredSpawnOffLoop` :888; `failSpawnOffLoop` :889; `beginSpawnRequest` :1060; `failStructuredSpawnOffLoop` :1109; `failSpawnOffLoop` :1110; `failStructuredSpawnOffLoop` :1116; `failSpawnOffLoop` :1117; `failStructuredSpawnOffLoop` :1272; `failStructuredSpawnOffLoop` :1303; `failSpawnOffLoop` :1513 | existing admission |
| `src/lib/agent/spawnCommand.ts` | `reconcileConversations` :1218; `upsert` :1231 | admitted boundary; see serving-caller completion |
| `src/lib/agent/spawnParent.ts` | `ensureConversation` :49 | admitted boundary; see serving-caller completion |
| `src/lib/agent/transcriptHost.ts` | `importResumePanes` :813; `rememberResumePane` :831 | async admission in L7 |
| `src/lib/agent/transcriptHost.ts` | `confirmSpawnPaneAlive` :642; `confirmSpawnPaneAlive` :708; `confirmSpawnPaneAlive` :722; `confirmSpawnPaneAlive` :744; `completeObservedSpawn` :745; `upsert` :782; `markUnhosted` :794; `reconcileSpawnReceipts` :797; `ensureConversation` :841; `beginSpawnRequest` :851 | admitted boundary; see serving-caller completion |
| `src/lib/conversation/transcriptAdmission.ts` | `reconcileConversations` :138 | admitted boundary; see serving-caller completion |
| `src/lib/delivery.ts` | `markUnhosted` :268; `markUnhosted` :700 | async admission in L7 |
| `src/lib/delivery.ts` | `requestConversationReseat` :199; `ensureConversation` :821; `holdDeliveryOffLoop` :947; `discardDelivery` :995; `beginDeliveryAttemptOffLoop` :1016; `requeueHeldDelivery` :1043; `recordDeliveryOutcome` :1139; `discardDelivery` :1142; `recordDeliveryArtifacts` :1194; `discardDelivery` :1329 | existing admission |
| `src/lib/externalRelay/ownerRun.ts` | `retireQueuedSpawnOffLoop` :274; `terminalizeHeldDelivery` :285; `terminalizeHeldDelivery` :298 | existing admission |
| `src/lib/flows/commands.ts` | `ensureConversation` :230; `rememberMembership` :289 | async admission in L7 |
| `src/lib/flows/engine.ts` | `rotateSpawnCapabilityForReceipt` :924; `repairHostlessSpawnMarkers` :1842 | async admission in L7 |
| `src/lib/flows/engine.ts` | `failSpawnOffLoop` :1078 | existing admission |
| `src/lib/flows/engine.ts` | `ensureConversation` :234; `rememberMembership` :237; `beginSpawnRequest` :263; `settleSpawn` :766; `endHostlessSpawn` :967 | admitted boundary; see serving-caller completion |
| `src/lib/links/testServer.ts` | `beginSpawnRequest` :221; `completeSpawn` :225; `rotateSpawnCapabilityForReceipt` :228; `rotateSpawnCapabilityForConversation` :242; `beginSpawnRequest` :255; `completeSpawn` :259; `rememberMembership` :266 | separate benchmark/fixture process; synchronous API retained |
| `src/lib/mcp/receiptStoreProbeChild.ts` | `holdDelivery` :137; `beginDeliveryAttempt` :147; `recordDeliveryOutcome` :154; `completeSpawn` :219 | separate benchmark/fixture process; synchronous API retained |
| `src/lib/monitor/seatTickSources.ts` | `recordDeliveryOutcomeForOperation` :622; `recordDeliveryOutcome` :628; `withdrawHeldDelivery` :722 | existing admission |
| `src/lib/orchestrator/deputyCommandPorts.ts` | `terminalizeHeldDelivery` :167 | existing admission |
| `src/lib/orchestrator/deputyCommandPorts.ts` | `ensureForkedConversation` :74 | admitted boundary; see serving-caller completion |
| `src/lib/orchestrator/seatChannel.ts` | `recordDeliveryOutcome` :273; `withdrawHeldDelivery` :275; `settleDirectAdmission` :302 | existing admission |
| `src/lib/orchestrator/seatCommand.ts` | `retireUnconsumedSpawn` :392 | async admission in L7 |
| `src/lib/orchestrator/seatCommand.ts` | `stampOrchestratorSeatIdentity` :422 | admitted boundary; see serving-caller completion |
| `src/lib/pipelines/engine.ts` | `ensureConversation` :673; `beginSpawnRequestAsync` :773; `failStructuredSpawnOffLoop` :813; `failStructuredSpawnOffLoop` :837; `failStructuredSpawnOffLoop` :850; `captureStructuredTerminationSurvivors` :1315; `withdrawStructuredTerminationSurvivors` :1323; `preserveSpawnArtifactOwnership` :1638; `claimFailedSpawnForRetry` :1735; `retryConversationMigration` :2072; `requestConversationReseat` :2075 | existing admission |
| `src/lib/pipelines/engine.ts` | `failNeverStartedStageSpawnNow` :1683 | existing single probe |
| `src/lib/pipelines/runtimeSwitch.ts` | `withdrawConversationReconfigure` :131; `cancelConversationSwitch` :137; `releaseSwitchHold` :148 | existing admission |
| `src/lib/pipelines/runtimeSwitchRecovery.ts` | `withdrawConversationReconfigure` :19; `cancelConversationSwitch` :25 | existing admission |
| `src/lib/reaperRuntime.ts` | `claim` :773; `markUnhosted` :787; `releaseClaim` :791 | async admission in L7 |
| `src/lib/reaperRuntime.ts` | `terminalizeStaleUndeliverableHeldDelivery` :885; `terminalizeRolledBackMigrationDelivery` :909; `clearRolledBackConversationMigration` :928; `terminalizeHeldDelivery` :944; `rollbackConversationMigration` :950; `setMigrationIntentState` :957; `terminalizeFailedSpawnDeliveriesNow` :996 | existing admission |
| `src/lib/runtime/accountCreditGuard.ts` | `requestConversationReseat` :198; `holdDelivery` :228 | existing admission |
| `src/lib/runtime/http.ts` | `recordDirectAdmission` :108; `recordDeliveryOutcomeForOperation` :662; `discardDeliveryForOperation` :724; `rearmUncertainDeliveryForOperation` :923; `beginDeliveryAttemptOffLoop` :950; `settleDirectAdmission` :1125 | existing admission |
| `src/lib/runtime/nativeQueueHttp.ts` | `recordDirectAdmission` :169; `settleDirectAdmission` :184 | existing admission |
| `src/lib/runtime/nativeQueueSettlement.ts` | `settleDirectAdmission` :27; `recordDeliveryOutcomeForOperation` :28 | existing admission |
| `src/lib/runtime/registry.ts` | `setStructuredHostClaimed` :114; `recordStructuredTerminationSurvivors` :657; `releaseStructuredHostClaim` :780; `claimStructuredHost` :827; `claimStructuredHost` :839; `releaseStructuredHostClaim` :844; `releaseStructuredHostClaim` :854; `setStructuredHostClaimed` :857; `releaseStructuredHostClaim` :880; `releaseStructuredHostClaim` :912; `setStructuredHostClaimed` :915; `claimStructuredHost` :969; `claimStructuredHost` :981; `releaseStructuredHostClaim` :986; `setStructuredHostClaimed` :995; `releaseStructuredHostClaim` :1016; `setStructuredHostClaimed` :1046; `releaseStructuredHostClaim` :1079 | async admission in L7 |
| `src/lib/runtime/registry.ts` | `setStructuredHostClaimed` :188; `captureStructuredTerminationSurvivors` :249; `releaseStructuredHostClaim` :266; `terminateInactiveStructuredHost` :536; `captureStructuredTerminationSurvivors` :645; `withdrawStructuredTerminationSurvivors` :649; `settleStructuredTerminationSurvivors` :652; `claimStructuredHost` :750; `claimStructuredHost` :762; `setStructuredHostClaimed` :771 | admitted boundary; see serving-caller completion |
| `src/lib/runtime/sendSettlement.ts` | `settleDeliveryRetryAttemptOffLoop` :1003; `recordDeliveryOutcomeForOperationOffLoop` :1013; `recordDeliveryOutcomeOffLoop` :1015; `recordDeliveryOutcomeForOperationOffLoop` :1022 | existing admission |
| `src/lib/runtime/startup.ts` | `reconcileConversations` :1488; `claimStructuredHost` :2269; `rotateSpawnCapabilityForPath` :2329; `rotateSpawnCapabilityForPath` :2397 | async admission in L7 |
| `src/lib/runtime/startup.ts` | `recordDirectAdmission` :1304; `settleDirectAdmission` :1355; `drainDeadSupersededHeldDeliveryCandidates` :2167 | existing admission |
| `src/lib/runtime/startup.ts` | `ensureConversation` :2308; `ensureConversation` :2378 | async admission in L7 |
| `src/lib/runtime/structuredControls.ts` | `releaseSwitchHold` :453; `withdrawConversationReconfigure` :463 | existing admission |
| `src/lib/runtime/structuredDeliveryController.ts` | `terminateInactiveStructuredHost` :1224; `recordStructuredTerminationSurvivors` :1273; `terminateStructuredHost` :1919; `terminateStructuredHost` :1926; `repairCompletedStructuredSpawnMarkers` :2010 | async admission in L7 |
| `src/lib/runtime/structuredDeliveryController.ts` | `recordDeliveryOutcomeForOperationOffLoop` :443; `recordDeliveryOutcomesForOperations` :480; `bindDeliveryBatchOffLoop` :912; `holdForFailedSwitch` :940; `bindDeliveryOperationGenerationOffLoop` :960; `recordDeliveryOutcomeForOperation` :1074; `failStructuredSpawnOffLoop` :1214 | existing admission |
| `src/lib/runtime/structuredDeliveryController.ts` | `recordStructuredTerminationSurvivors` :1262; `terminateStructuredHost` :1269; `markStructuredHostHandoff` :2481 | admitted boundary; see serving-caller completion |
| `src/lib/runtime/structuredHostControl.ts` | `terminateStructuredHost` :443 | existing admission |
| `src/lib/runtime/structuredHostRetirement.ts` | `recordStructuredTerminationSurvivors` :1158 | admitted boundary; see serving-caller completion |
| `src/lib/runtime/structuredMessageDelivery.ts` | `terminalizeHeldDelivery` :242; `holdDeliveryOffLoop` :732; `recordDeliveryOutcome` :1168; `terminalizeHeldDelivery` :1178; `holdDeliveryOffLoop` :1725; `requestConversationMigrationToActiveAccount` :1752; `retryUncertainDelivery` :1982; `terminalizeHeldDelivery` :1997; `recordDeliveryOutcomeOffLoop` :2061; `beginDeliveryAttemptOffLoop` :2066; `terminalizeHeldDelivery` :2087; `requeueHeldDelivery` :2122; `recordDeliveryOutcome` :2143; `recordDeliveryOutcome` :2160 | existing admission |
| `src/lib/runtime/structuredReconfigure.ts` | `terminateStructuredHost` :222; `terminateStructuredHost` :240; `terminateStructuredHost` :245; `terminateStructuredHost` :311; `terminateStructuredHost` :339; `terminateStructuredHost` :358 | async admission in L7 |
| `src/lib/runtime/structuredReconfigure.ts` | `claimConversationReconfigure` :135; `settleConversationReconfigure` :158; `requestConversationReseat` :276; `holdUndispatchedClaimsForSwitch` :286 | existing admission |
| `src/lib/runtime/structuredRecovery.ts` | `terminateStructuredHost` :434; `terminateStructuredHost` :600 | async admission in L7 |
| `src/lib/runtime/structuredRecovery.ts` | `beginSpawnRequestAsync` :468; `failSpawnOffLoop` :507; `failSpawnOffLoop` :515 | existing admission |
| `src/lib/runtime/structuredSpawn.ts` | `recoverStructuredSpawnFromEvidence` :728; `claimTmuxSpawnActuation` :893; `claimStartingStructuredSpawn` :894; `queuePinnedSpawn` :947; `releaseSpawnActuation` :952; `markSpawnPathPending` :990; `releaseSpawnActuation` :1020; `releaseSpawnActuation` :1026; `claimStructuredHost` :1644; `claimStructuredHost` :1691; `claimStructuredHost` :1705; `finalizeStructuredSpawn` :1738; `recoverDeliveredStructuredSpawn` :1750; `finalizeStructuredSpawn` :1793; `recoverStructuredSpawnFromEvidence` :2321; `recoverStructuredSpawnFromEvidence` :2428; `rotateSpawnCapabilityForReceipt` :2618; `setReceiptViewerMcpTransport` :2619; `setReceiptViewerMcpTransport` :2648; `stageStructuredSpawn` :2656; `claimStructuredHost` :2679; `releaseStructuredSpawnAdmissionOwner` :2771; `releaseStructuredSpawnAdmissionOwner` :2794; `finalizeStructuredSpawn` :2841; `releaseStructuredSpawnAdmissionOwner` :2868 | async admission in L7 |
| `src/lib/runtime/structuredSpawn.ts` | `recordDeliveryOutcome` :418; `recordDeliveryOutcome` :427; `failStructuredSpawnOffLoop` :520; `failStructuredSpawnOffLoop` :855; `failSpawnOffLoop` :857; `releaseSpawnActuation` :900; `admitRecoveredLaunch` :915; `failSpawnOffLoop` :1016; `backfillFailedLaunchReporting` :1087; `terminalizeAbandonedSpawnEntries` :1097; `failSpawnOffLoop` :1139; `failStructuredSpawnOffLoop` :1167; `failStructuredSpawnOffLoop` :1591; `failStructuredSpawnOffLoop` :1628; `failSpawnOffLoop` :1679; `failSpawnOffLoop` :1693; `failStructuredSpawnOffLoop` :1721; `failStructuredSpawnOffLoop` :2939; `failSpawnOffLoop` :2943; `releaseStructuredSpawnAdmissionOwner` :2958 | existing admission |
| `src/lib/runtime/structuredSpawn.ts` | `reportFailedLaunch` :1091 | existing single probe |
| `src/lib/runtime/structuredSpawn.ts` | `setStructuredHostClaimed` :1360; `releaseStructuredHostClaim` :1370; `preserveSpawnArtifactOwnership` :2255; `claimStructuredHost` :2578 | admitted boundary; see serving-caller completion |
| `src/lib/telegram/bot/reportReplies.ts` | `withdrawHeldDelivery` :77 | existing admission |
| `src/lib/tmux.ts` | `rotateSpawnCapabilityForReceipt` :1311; `bindSpawnPane` :1342; `rotateSpawnCapabilityForReceipt` :1355; `markSpawnHostVerified` :1419; `invalidateSpawnHost` :1439; `invalidateSpawnHost` :1449; `invalidateSpawnHost` :1465; `markSpawnPromptDelivered` :1468 | async admission in L7 |
| `src/lib/tmux.ts` | `failSpawnOffLoop` :1548; `beginSpawnRequestAsync` :1556; `failSpawnOffLoop` :1569 | existing admission |
| `src/test-helpers/migrationDelivery.ts` | `reconcileConversations` :20; `upsert` :24; `holdDelivery` :54; `beginDeliveryAttempt` :56 | separate benchmark/fixture process; synchronous API retained |

## Serving-caller completion

The original table includes synchronous helper bodies called inside admitted
callbacks. A synchronous body under a held writer does not acquire a second
writer. Production enters these bodies through the following awaited boundaries;
standalone synchronous exports remain for isolated fixtures.

| Family | Serving admission and validation after waiting |
| --- | --- |
| Host checkpoints | `bindStructuredHostPersistence`: ordered initial, material, cursor and terminal writes use `registry.host-checkpoint`; the atomic mutator compares claim owner and epoch. Cursor-only changes coalesce. The returned stop can be awaited and `flush()` acknowledges queued checkpoints. A shared weak map binds each host to that flush; published and unpublished release paths await it before acknowledging demotion. Codex also receives the same flush through `setPersistenceFlush`, so direct and repeated `release()` calls await their checkpoint after transport cleanup. Unbound hosts have no flush callback; the other engines retain their existing controller flush. |
| Host stop capture | The Claude capture listener accepts a promise. The engine awaits capture before closing stdin or signalling, then rechecks the release fence. Registry capture rereads the recorded root inside admission. |
| Host demotion and dead rows | Startup demotion admits `mutation()` before it runs, repeating release authority and the evidence stamp. The reaper and recovery use the admitted dead-host helpers; captured process/claim custody is compared again on current rows, one row per admission. |
| Host termination | Operator API, idle retirement, controller and orphan capture/withdraw/settle callbacks use async admission. Root identity, current authorization and captured custody remain checked at the mutation. |
| Demotion handoff | The interruption evidence callback awaits registry admission, repeats transcript/idle evidence, then marks the exact process before recording its owed continuation. |
| Accounts | Selection uses `accountMutationWrite`, which takes the account lease and probes the registry without waiting, releases both before retrying, preserves FIFO and rechecks account revision/identity. The SQLite probe is released before catalog writes: catalog and registry can share `state.sqlite`. Subsequent registry writes still use zero-wait probes while account custody remains held; a deferred callback rolls back or retries idempotently. |
| Migration transitions | The coordinator's `advance` already delegates to `offLoopOrBusy`. These rows were classified as callback exceptions in L7 but had async admission. |
| Successor capability | Stage and restore both await admission; staging repeats linked-install refusal and the mutator checks migration operation ownership; rollback compares operation and digest. |
| Spawn account correction | `recordActualSpawnAccountOffLoop` rereads the materialized receipt, entry and conversation after admission and performs the paired writes without yielding. |
| Spawn lineage | `resolveSpawnLineageOffLoop` repeats the entire role, selector, transcript provenance and identity resolution inside admission. |
| Transcript hosts | Observation reconciliation is grouped inside admission, with renewed process identity/argv/ancestry evidence. Confirmation repeats that evidence. Resume admits identity first, then uses `beginSpawnRequestAsync` so task membership runs without a held registry transaction. Generation and delivery authority guards repeat at every phase; an unactuated revoked receipt is failed durably. |
| Transcript admission | The entire identity decision, including readability, foreign liveness and account provenance, runs after admission. |
| Flows | Reservation admits identity and membership separately, then uses `beginSpawnRequestAsync`, rechecking flow, account and generation evidence at each phase. Work yields between phases; task membership does not hold the registry writer. Settlement repeats flow revision inside admission; hostless markers are retired through admission before their in-memory round is reset. |
| Deputy | Registration is awaited and repeats the seat conversation/epoch guard inside admission. |
| Seat | Runtime metadata is prepared outside the lease. Identity repair and publication use account custody and nonblocking registry probes, never a registry transaction around a sibling state write; registry revision, seated conversation and epoch are reread after waiting. |
| Staged spawn | Claim/release and recovery checkpoint helpers await admission. Resume repeats its pre-claim guard; atomic release compares owner/epoch. Recovery compares the prior receipt outcome and row custody before writing. |
| Identity migration | Its delayed startup retry can run while serving. It now uses account admission and a nonblocking registry probe, releasing SQLite before any external seat rekey; evidence is read after admission and the migration retains its registry/seat validation. Its retry supervisor handles promise rejection. |

There are no retained serving synchronous-wait exceptions in this inventory.
No startup-only exception is claimed: deferred startup, demotion and migration
retries can run after requests are accepted. Registry construction/open is outside
this change and remains owned by the signal-sandbox lane. Benchmark, dataset,
capture and child-fixture processes listed above keep their synchronous API.

### Codex release regression reproduction

On 2026-10-19, the complete native CI command was run on the pinned PR head
and its merge base with `origin/main`, under the Dockerfile's Bun 1.4.0 pin:

| Revision | Codex fixture | Native verifier exit | Boot re-host test |
| --- | --- | --- | --- |
| `ba1f7cfb` (pinned head) | 0.154.0 | 1 | failed after `host.release()` |
| `ba1f7cfb` (pinned head) | 0.159.0 | 1 | failed after `host.release()` |
| `5b2a6333` (merge base) | 0.154.0 | 0 | passed |
| `5b2a6333` (merge base) | 0.159.0 | 0 | passed |

The workflow is `.github/workflows/bun-runtime.yml`, job
`native-codex-runtime`. Install each fixture with
`npm install --prefix "$fixture" --no-save --ignore-scripts @openai/codex@<version>`,
then run `bun scripts/verify-native-codex-runtime.ts <absolute-fixture-executable>`
through the project's gate-slot wrapper. Head and base used separate source
exports; each observation used private HOME, XDG_CONFIG_HOME, TMPDIR, CODEX_HOME and LLV_STATE_DIR,
with `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`; the verifier also creates its own
isolated test environment. Dependency manifests matched across the two revisions.

Both head failures left the registry row live and its claim owned after the
transport had ended. The existing boot re-host test remains unchanged. Added
cases in `src/lib/runtime/codexAppServerHost.test.ts` hold a real SQLite writer
through the terminal-state notification and check that first and repeated release
acknowledgements stay pending while the event loop progresses. After admission,
a newly opened registry must see the unhosted row and released claim. The same
checks cover a shutdown event-log write failure. The fix retains the existing
async writer admission, deadlines and checkpoint correlation labels; it claims
no performance gain.

## Production caller attribution

The read-only journal query used UTC bounds `2026-10-19 01:55:00` through
`04:07:00`, service `delegatus.service`, output `cat`, with all lines retained
locally. Only each payload's own `role: viewer` is attributed to the Viewer;
the service manager's PID is not used. The two wait records for one mutation
are nested measurements, so their durations must not be added.

| Payload time (UTC) | Serving revision | Exact compiled call site | Source attribution |
| --- | --- | --- | --- |
| 01:57:46.214 / .215 | `850365db5632` | `53740.js:88:15242` → `:15625` | `bindStructuredHostPersistence`, `persist(await host.health())`: initial `setStructuredHostClaimed`; 292.5 ms lock / 294.6 ms retry. |
| 02:35:13.247 | `850365db5632` | `53740.js:88:15242` → `:16476` → `:16562` | The same binding's `persistPending` and cursor timer: `setStructuredHostClaimed`; 311.2 ms lock / 312.5 ms retry. |
| 04:05:45.506 | `1f3872d6aec6` | `28299.js:255:56849` → `:601:1404` | `withPipelineStartupAdmission` invoking its admitted callback, under the state collection's async lease. The registry method frame is absent; this stack alone cannot distinguish its inlined mutations. The synchronous `mutation()` callback in `adoptStructuredHostsPass`/`demoteSkippedStructuredRegistryHosts` is removed as a wait path. 418.1 ms lock / 419.5 ms retry. |

The exact columns were read against the retained compiled chunks of those
revisions. The corresponding loop-gap payloads have no JS profile, so there is
no profiler frame to strengthen the third attribution. The first two stacks
identify the actual mutation, independent of the minified subject `l`.
The third row's caller family is resolved by the matching startup chunk:
`63573.js:7:38541` ends the demotion admission callback in a synchronous
`b()` (`mutation()` in source). The other callbacks under that boundary read
pipeline evidence or use the already-admitted `claimStructuredHost`. This is a
reachability inference from the retained code and the exact logged boundary;
the stack cannot distinguish the demotion helper's dead-row reconciliation,
claim and terminal-checkpoint mutations.

The seat's post-deploy acceptance query is a complete 24-hour window of
`[blocking-wait]` payloads with `role == "viewer"`, `synchronous == true`
and a registry wait site. Expected count: **zero**. Count unattributed lines
separately. Deployment and that observation belong to the seat; this stage
claims only isolated fixtures and the named runtime rehearsal.

## Internal reachability

| Method and pinned line | Calls towards storage |
| --- | --- |
| `mutate` :5437 | `mutateStorage` |
| `mutateStorage` :5450 |  |
| `setReceiptViewerMcpTransport` :5921 | `mutate` |
| `backfillFailedLaunchReporting` :6058 | `mutate` |
| `reportFailedLaunch` :6085 | `mutate` |
| `terminalizeAbandonedSpawnEntries` :6110 | `mutate` |
| `rotateSpawnCapabilityForReceipt` :6131 | `mutate` |
| `rotateSpawnCapabilityForPath` :6147 | `rotateSpawnCapabilityWhere` |
| `stageSpawnCapabilityForConversation` :6157 | `mutate` |
| `discardSpawnCapabilityForOperation` :6181 | `mutate` |
| `rotateSpawnCapabilityForConversation` :6194 | `rotateSpawnCapabilityWhere` |
| `rotateSpawnCapabilityWhere` :6206 | `mutate` |
| `beginSpawnRequestAsync` :6235 | `reserveSpawnRequest`, `admitSpawnMembership`, `recordSpawnMembership` |
| `reserveSpawnRequest` :6306 | `mutate` |
| `admitSpawnMembership` :6328 | `failStructuredSpawn`, `failSpawn` |
| `beginSpawnRequest` :6336 | `reserveSpawnRequest`, `admitSpawnMembership`, `recordSpawnMembership` |
| `admitRecoveredLaunch` :6353 | `recordSpawnMembership` |
| `recordSpawnMembership` :6359 | `mutate` |
| `retireUnconsumedSpawn` :6372 | `mutate` |
| `claimSpawnActuation` :6701 | `mutate` |
| `queuePinnedSpawn` :6725 | `mutate` |
| `retireQueuedSpawnOffLoop` :6753 | `mutate` |
| `claimStartingStructuredSpawn` :6773 | `claimSpawnActuation` |
| `claimTmuxSpawnActuation` :6780 | `claimSpawnActuation` |
| `releaseSpawnActuation` :6788 | `mutate` |
| `releaseStartingStructuredSpawn` :6812 | `mutate` |
| `releaseStructuredSpawnAdmissionOwner` :6828 | `mutate` |
| `claimFailedSpawnForRetry` :6842 | `mutate` |
| `rememberMembership` :6858 | `mutate` |
| `runIdentityWaveMigration` :6866 | `mutate` |
| `stampOrchestratorSeatIdentity` :6892 | `mutate` |
| `beginSpawn` :6906 | `beginSpawnRequest` |
| `bindSpawnPane` :6912 | `mutate` |
| `markSpawnHostVerified` :6929 | `mutate` |
| `markSpawnPromptDelivered` :6951 | `mutate` |
| `markSpawnPathPending` :6970 | `mutate` |
| `preserveSpawnArtifactOwnership` :6979 | `mutate` |
| `confirmSpawnPaneAlive` :7018 | `mutate` |
| `stageStructuredSpawn` :7292 | `mutate` |
| `finalizeStructuredSpawn` :7305 | `mutate` |
| `recoverDeliveredStructuredSpawn` :7346 | `mutate` |
| `recoverStructuredSpawnFromEvidence` :7394 | `mutate` |
| `settleSpawn` :7459 | `mutate` |
| `completeSpawn` :7469 | `settleSpawn` |
| `failSpawn` :7475 | `failSpawnInFile`, `reportFailedLaunch` |
| `failSpawnOffLoop` :7491 | `failSpawnInFile`, `reportFailedLaunch` |
| `failSpawnNow` :7502 | `failSpawnInFile`, `reportFailedLaunch` |
| `failNeverStartedStageSpawnNow` :7513 | `failStructuredSpawnInFile`, `reportFailedLaunch` |
| `failSpawnInFile` :7586 | `mutate` |
| `terminalizeFailedSpawnDeliveries` :7623 | `mutate` |
| `terminalizeFailedSpawnDeliveriesNow` :7630 | `mutate` |
| `failStructuredSpawn` :7656 | `failStructuredSpawnInFile`, `reportFailedLaunch` |
| `failStructuredSpawnOffLoop` :7668 | `failStructuredSpawnInFile`, `reportFailedLaunch` |
| `failStructuredSpawnInFile` :7683 | `mutate` |
| `invalidateSpawnHost` :7790 | `mutate` |
| `upsert` :7800 | `mutate` |
| `setStructuredHost` :7822 | `mutate` |
| `terminateStructuredHost` :7855 | `mutate` |
| `recordStructuredTerminationSurvivors` :7888 | `captureStructuredTerminationSurvivors` |
| `captureStructuredTerminationSurvivors` :7901 | `mutate` |
| `withdrawStructuredTerminationSurvivors` :7937 | `mutate` |
| `settleStructuredTerminationSurvivors` :7968 | `mutate` |
| `endHostlessSpawn` :8007 | `mutate` |
| `repairHostlessSpawnMarkers` :8023 | `mutate` |
| `terminateInactiveStructuredHost` :8067 | `mutate` |
| `setStructuredHostClaimed` :8109 | `mutate` |
| `markStructuredHostHandoff` :8162 | `mutate` |
| `claimStructuredHost` :8210 | `mutate` |
| `markUnhosted` :8282 | `mutate` |
| `claim` :8297 | `mutate` |
| `releaseClaim` :8309 | `mutate` |
| `releaseStructuredHostClaim` :8320 | `mutate` |
| `importResumePanes` :8345 | `mutate` |
| `rememberResumePane` :8360 | `mutate` |
| `reconcileSpawnReceipts` :8368 | `mutate` |
| `repairCompletedStructuredSpawnMarkers` :8386 | `mutate` |
| `completeObservedSpawn` :8445 | `settleSpawn` |
| `ensureForkedConversation` :8453 | `ensureConversation`, `mutate` |
| `ensureConversation` :8469 | `mutate` |
| `reconcileConversations` :8513 | `mutate` |
| `recordSupersedence` :8846 | `mutate` |
| `clearSupersedence` :8881 | `mutate` |
| `updateConversationLaunchProfile` :8945 | `mutate` |
| `claimConversationReconfigure` :8958 | `mutate` |
| `settleConversationReconfigure` :9036 | `mutate` |
| `withdrawConversationReconfigure` :9081 | `mutate` |
| `holdForFailedSwitch` :9103 | `mutate` |
| `releaseSwitchHold` :9122 | `mutate` |
| `cancelConversationSwitch` :9158 | `mutate` |
| `setEngineRouting` :9215 | `mutate` |
| `retireAccount` :9251 | `retireAccountInFile` |
| `retireAccountNow` :9269 | `retireAccountInFile` |
| `retireAccountInFile` :9284 | `mutate` |
| `rewriteAccountPaths` :9359 | `mutate` |
| `commitMigrationIntent` :9373 | `mutate` |
| `requestConversationMigrationToActiveAccount` :9509 | `mutate` |
| `requestConversationReseat` :9620 | `mutate` |
| `upsertMigrationIntent` :9723 | `mutate` |
| `setConversationMigration` :9740 | `mutate` |
| `transitionConversationMigration` :9763 | `mutate` |
| `persistMigrationProviderReceipt` :9780 | `mutate` |
| `recordConversationContinuityPath` :9816 | `mutate` |
| `recordMigrationContinuityPath` :9828 | `mutate` |
| `markMigrationBoardProjects` :9851 | `mutate` |
| `markMigrationBoardPlacementProjects` :9868 | `mutate` |
| `retryConversationMigration` :9883 | `mutate` |
| `commitSuccessor` :9940 | `mutate` |
| `setMigrationIntentState` :10008 | `mutate` |
| `recordQuotaObservation` :10069 | `mutate` |
| `recordQuotaEvaluation` :10075 | `mutate` |
| `setAutoBalancePolicy` :10109 | `mutate` |
| `recordAutoBalanceOutcome` :10120 | `mutate` |
| `holdDelivery` :10146 | `mutate` |
| `holdDeliveryOffLoop` :10294 | `holdDelivery` |
| `terminalizeHeldDelivery` :10433 | `mutate` |
| `terminalizeOrphanedHeldDelivery` :10446 | `mutate` |
| `terminalizeStaleUndeliverableHeldDelivery` :10465 | `mutate` |
| `withdrawHeldDelivery` :10482 | `mutate` |
| `drainDeadSupersededHeldDeliveries` :10497 | `drainDeadSupersededHeldDeliveryCandidates` |
| `drainDeadSupersededHeldDeliveryCandidates` :10514 | `mutate` |
| `terminalizeRolledBackMigrationDelivery` :10527 | `mutate` |
| `compactDeliveryReservations` :10531 | `mutate` |
| `queueSuccessorCleanup` :10549 | `mutate` |
| `recordSuccessorCleanupFailure` :10558 | `mutate` |
| `completeSuccessorCleanup` :10565 | `mutate` |
| `beginDeliveryAttempt` :10569 | `mutate` |
| `beginDeliveryAttemptOffLoop` :10603 | `beginDeliveryAttempt` |
| `recordDeliveryArtifacts` :10611 | `mutate` |
| `restoreSnapshot` :10621 | `mutate` |
| `recordDeliveryRetryAttempt` :10649 | `recordDirectAdmission` |
| `recordDirectAdmission` :10673 | `mutate` |
| `bindDeliveryOperationGeneration` :10847 | `writeDeliveryOperationGeneration` |
| `bindDeliveryOperationGenerationOffLoop` :10856 | `writeDeliveryOperationGeneration` |
| `bindDeliveryBatchOffLoop` :10867 | `mutate` |
| `writeDeliveryOperationGeneration` :10882 | `mutate` |
| `settleDeliveryRetryAttempt` :10901 | `mutate` |
| `settleDirectAdmission` :10927 | `settleDeliveryRetryAttempt` |
| `settleDeliveryRetryAttemptOffLoop` :10933 | `settleDeliveryRetryAttempt` |
| `recordDeliveryOutcomeOffLoop` :10944 | `recordDeliveryOutcome` |
| `recordDeliveryOutcome` :10953 | `mutate` |
| `recordDeliveryOutcomeForOperation` :10997 | `recordDeliveryOutcomesForOperations` |
| `recordDeliveryOutcomeForOperationOffLoop` :11018 | `recordDeliveryOutcomeForOperation` |
| `recordDeliveryOutcomesForOperations` :11029 | `mutate` |
| `discardDelivery` :11098 | `mutate` |
| `requeueHeldDelivery` :11115 | `placeDeliveryForRetry` |
| `retryUncertainDelivery` :11119 | `placeDeliveryForRetry` |
| `retryUncertainDeliveryForOperation` :11127 | `rearmUncertainDeliveryForOperation` |
| `rearmUncertainDeliveryForOperation` :11133 | `mutate` |
| `discardDeliveryForOperation` :11158 | `mutate` |
| `holdUndispatchedClaimsForSwitch` :11232 | `mutate` |
| `requeueUnactuatedDelivery` :11263 | `mutate` |
| `placeDeliveryForRetry` :11275 | `mutate` |
| `rollbackConversationMigration` :11283 | `mutate` |
| `clearRolledBackConversationMigration` :11312 | `mutate` |

Full snapshot loads and incremental snapshot refreshes also share an admitted
writer transaction. Their standalone readers still own their transactions;
borrowed readers never commit or roll back the writer. Regression coverage
includes cold, warm and prepared readers, peer commits, detached snapshots,
refusal cleanup, and replacement-host preservation during admission.

## Verification scope

`src/lib/agent/registry.writerWait.test.ts` exercises the real policy PATCH
handlers with a child-held writer, concurrent expected-revision writes,
deadline refusal/retry, reopened state, prior-observation freshness, and row-read
bounds with unrelated conversation history. The initial held-lock control is
red at 202.55 ms on the base and green at 10.17 ms while the write is pending.
Those measurements describe the isolated fixture. The stage report records
final checks and repeated samples; production throughput is unmeasured.

The synchronous store remains available to CLI/helper processes and admitted
callback bodies. The serving-caller completion above records their production
entry points. `src/lib/agent/registry.servingWriters.test.ts` holds the writer in a
child process for each moved family and requires a 10 ms timer to run within
50 ms while the operation remains pending. A 5 ms observer also bounds gaps
through recovery. These serving fixtures initialize their private account and
board catalogs before timing, as the production command prerequisites do;
registry operations are not prewarmed. Revocation cases repeat the guards
after admission. `src/lib/runtime/registryPersistence.test.ts` retains its
coalescing, ordered transition and terminal-custody assertions.

## Post-admission ownership audit

Audit verdict: **PASS** for every caller row marked `async admission in L7` in
the caller inventory above. Each row's revision, receipt, claim, or operation
identity is checked by its atomic registry mutator or repeated inside the
admitted callback. The complete site list remains in the `Callers` table.

The review found and fixed these termination sites, where an asynchronous
admission had introduced a gap between the prior authority check and the
destructive registry write:

| Sites | Verdict and guard |
| --- | --- |
| `src/lib/runtime/structuredReconfigure.ts` `terminateReleasedHost` calls at lines 277, 299, 308, 378, 411, 434 | **FIXED** — each checks operation/generation ownership and the captured claim epoch, owner, writer epoch, and process in the admitted callback; the registry mutator repeats custody atomically. |
| `src/lib/runtime/structuredRecovery.ts` calls at lines 448 and 626 | **FIXED** — the first atomically compares captured row custody after checking request and operation ownership; failure cleanup also rechecks successor ownership and captured custody in its admitted callback. |
| `src/lib/runtime/structuredDeliveryController.ts` qualified and unqualified `terminateActiveHost` calls at lines 1936 and 1951 | **FIXED** — both capture claim epoch, owner, writer epoch, and process before release, then compare that custody in the admitted registry mutation. |
| `src/lib/runtime/structuredDeliveryController.ts` `retireRegistryEntry` at line 1278 | **FIXED** — captures custody before the process-tree termination awaits and passes it to the atomic retirement mutation alongside the authorized process and confirmed survivors. |
| `src/lib/runtime/structuredHostControl.ts` default `retireRegistryEntry` at line 457 | **FIXED** — captures custody before any process-tree await and supplies it to every retirement outcome, including already-exited roots. |
| `src/lib/runtime/registry.ts` orphan stop at line 646 | **ALREADY SAFE** — it uses `settleStructuredTerminationSurvivors`, whose atomic mutation requires the exact root process, a dead process owner, and confirmation of every retained survivor. |

Other post-await ownership transfers in `src/lib/runtime/structuredSpawn.ts` and
`src/lib/accounts/migration/provider.ts` release the old host before calling
`claimStructuredHost`; the atomic claim mutator rechecks the current row and
writer epoch. Direct synchronous `terminateStructuredHost` calls in tests and
pipeline fixtures do not cross an await.

`src/lib/agent/registry.ts` also gives `accountMutationWrite` the same FIFO
admission queue as `deliveryWrite*`. Each ticket's deadline includes time spent
behind earlier tickets; an expired ticket refuses without invoking its writer
callback, while later tickets retain FIFO order. Retry waits run after the
account lease is released. The mixed policy/quota race, policy/policy ordering,
and queued deadline refusals for both APIs pass.
