# Registry write caller map (L7)

The map was made **before editing**, against `c10380df`. All table locations
are pinned to that revision; find later code by method name. The inventory
follows `this.mutateStorage` backwards through the `AgentRegistry` methods and
resolves external call signatures with TypeScript. Test modules are excluded;
benchmark and child-fixture consumers are explicitly classified below.

## Wait producers

| Site | Producer | Consumers and behavior |
| --- | --- | --- |
| `registry-lock` | `SqliteAgentRegistryStore.mutate` → `beginMutationWrite` → `noteWriterWait` | `AgentRegistry.mutateStorage` and all mutations below; optimistic acquisition followed by a pessimistic retry |
| `registry-revision-retry` | `SqliteAgentRegistryStore.mutate` after a lost optimistic revision | The same mutations; rolls back and retries under the writer, with the existing retry ceiling |
| `registry-lock-async` | `SqliteAgentRegistryStore.withWriter` via `AgentRegistry.deliveryWrite*` | Admitted mutations retain the lock through their synchronous callback and commit, preventing a lost revision |

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
| `scripts/capture-issue-1418-accounts-dialog.ts` | `recordQuotaEvaluation` :128; `recordQuotaEvaluation` :149 | separate benchmark/fixture process; synchronous API retained |
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
| `src/app/api/runtime/hosts/route.ts` | `recordStructuredTerminationSurvivors` :77 | synchronous callback retained |
| `src/app/api/session/supersedence/route.ts` | `clearSupersedence` :39 | async admission in L7 |
| `src/app/api/tasks/[id]/spawn/route.ts` | `claimTmuxSpawnActuation` :408; `settleSpawn` :476; `markSpawnPathPending` :490; `markSpawnPathPending` :496 | async admission in L7 |
| `src/app/api/tasks/[id]/spawn/route.ts` | `beginSpawnRequestAsync` :355; `failSpawnOffLoop` :434; `failSpawnOffLoop` :439; `failSpawnOffLoop` :449; `failSpawnOffLoop` :512 | existing admission |
| `src/lib/accounts/liveLimits.ts` | `recordQuotaObservation` :65 | production uses recordLiveObservationOffLoop in L7 |
| `src/lib/accounts/manager.ts` | `setEngineRouting` :547; `setEngineRouting` :552 | synchronous callback retained |
| `src/lib/accounts/migration/conversationCommand.ts` | `requestConversationReseat` :223; `withdrawConversationReconfigure` :274; `releaseSwitchHold` :304; `cancelConversationSwitch` :323; `rollbackConversationMigration` :343; `retryConversationMigration` :369 | existing admission |
| `src/lib/accounts/migration/coordinator.ts` | `reconcileConversations` :574; `reconcileConversations` :578; `commitMigrationIntent` :624 | async admission in L7 |
| `src/lib/accounts/migration/coordinator.ts` | `reconcileConversations` :573; `markMigrationBoardPlacementProjects` :865; `markMigrationBoardProjects` :895; `completeSuccessorCleanup` :919; `queueSuccessorCleanup` :926; `completeSuccessorCleanup` :931; `recordSuccessorCleanupFailure` :934; `recordMigrationContinuityPath` :1113; `persistMigrationProviderReceipt` :1119; `commitSuccessor` :1207; `recordDeliveryOutcome` :1292; `beginDeliveryAttempt` :1308; `recordDeliveryOutcome` :1332; `recordDeliveryOutcome` :1346; `requeueUnactuatedDelivery` :1347; `recordDeliveryOutcome` :1351; `recordDeliveryOutcome` :1355; `terminalizeOrphanedHeldDelivery` :1462; `terminalizeRolledBackMigrationDelivery` :1481; `rollbackConversationMigration` :1512; `recordAutoBalanceOutcome` :1610; `setMigrationIntentState` :1612 | existing admission |
| `src/lib/accounts/migration/coordinator.ts` | `transitionConversationMigration` :1012; `transitionConversationMigration` :1041; `rollbackConversationMigration` :1061; `transitionConversationMigration` :1068; `transitionConversationMigration` :1074; `transitionConversationMigration` :1087; `transitionConversationMigration` :1259 | synchronous callback retained |
| `src/lib/accounts/migration/provider.ts` | `upsert` :316; `setStructuredHost` :333; `claimStructuredHost` :346; `releaseStructuredHostClaim` :368; `releaseStructuredHostClaim` :425; `upsert` :459; `setStructuredHost` :476; `claimStructuredHost` :489; `releaseStructuredHostClaim` :507; `releaseStructuredHostClaim` :578; `discardSpawnCapabilityForOperation` :1559 | async admission in L7 |
| `src/lib/accounts/migration/provider.ts` | `stageSpawnCapabilityForConversation` :268; `discardSpawnCapabilityForOperation` :275 | synchronous callback retained |
| `src/lib/accounts/migration/quotaController.ts` | `recordQuotaObservation` :352; `recordQuotaEvaluation` :359 | combined account/registry admission in L7 |
| `src/lib/accounts/removal.ts` | `restoreSnapshot` :580; `restoreSnapshot` :887; `rewriteAccountPaths` :979 | existing admission |
| `src/lib/accounts/removal.ts` | `retireAccountNow` :567; `retireAccountNow` :870; `retireAccountNow` :964 | existing single probe |
| `src/lib/agent/identityWaveStartup.ts` | `runIdentityWaveMigration` :189 | synchronous callback retained |
| `src/lib/agent/registry.sqliteChild.ts` | `ensureConversation` :40; `ensureConversation` :50; `upsert` :81; `claimStructuredHost` :85; `setStructuredHostClaimed` :94; `ensureConversation` :104 | separate benchmark/fixture process; synchronous API retained |
| `src/lib/agent/spawnCommand.ts` | `queuePinnedSpawn` :1194; `claimStartingStructuredSpawn` :1352; `releaseStartingStructuredSpawn` :1361; `releaseSpawnActuation` :1377; `releaseSpawnActuation` :1389; `invalidateSpawnHost` :1449; `markSpawnPathPending` :1454; `settleSpawn` :1457; `invalidateSpawnHost` :1493; `markSpawnPathPending` :1532 | async admission in L7 |
| `src/lib/agent/spawnCommand.ts` | `beginSpawnRequestAsync` :876; `failStructuredSpawnOffLoop` :888; `failSpawnOffLoop` :889; `beginSpawnRequest` :1060; `failStructuredSpawnOffLoop` :1109; `failSpawnOffLoop` :1110; `failStructuredSpawnOffLoop` :1116; `failSpawnOffLoop` :1117; `failStructuredSpawnOffLoop` :1272; `failStructuredSpawnOffLoop` :1303; `failSpawnOffLoop` :1513 | existing admission |
| `src/lib/agent/spawnCommand.ts` | `reconcileConversations` :1218; `upsert` :1231 | synchronous callback retained |
| `src/lib/agent/spawnParent.ts` | `ensureConversation` :49 | synchronous callback retained |
| `src/lib/agent/transcriptHost.ts` | `importResumePanes` :813; `rememberResumePane` :831 | async admission in L7 |
| `src/lib/agent/transcriptHost.ts` | `confirmSpawnPaneAlive` :642; `confirmSpawnPaneAlive` :708; `confirmSpawnPaneAlive` :722; `confirmSpawnPaneAlive` :744; `completeObservedSpawn` :745; `upsert` :782; `markUnhosted` :794; `reconcileSpawnReceipts` :797; `ensureConversation` :841; `beginSpawnRequest` :851 | synchronous callback retained |
| `src/lib/conversation/transcriptAdmission.ts` | `reconcileConversations` :138 | synchronous callback retained |
| `src/lib/delivery.ts` | `markUnhosted` :268; `markUnhosted` :700 | async admission in L7 |
| `src/lib/delivery.ts` | `requestConversationReseat` :199; `ensureConversation` :821; `holdDeliveryOffLoop` :947; `discardDelivery` :995; `beginDeliveryAttemptOffLoop` :1016; `requeueHeldDelivery` :1043; `recordDeliveryOutcome` :1139; `discardDelivery` :1142; `recordDeliveryArtifacts` :1194; `discardDelivery` :1329 | existing admission |
| `src/lib/externalRelay/ownerRun.ts` | `retireQueuedSpawnOffLoop` :274; `terminalizeHeldDelivery` :285; `terminalizeHeldDelivery` :298 | existing admission |
| `src/lib/flows/commands.ts` | `ensureConversation` :230; `rememberMembership` :289 | async admission in L7 |
| `src/lib/flows/engine.ts` | `rotateSpawnCapabilityForReceipt` :924; `repairHostlessSpawnMarkers` :1842 | async admission in L7 |
| `src/lib/flows/engine.ts` | `failSpawnOffLoop` :1078 | existing admission |
| `src/lib/flows/engine.ts` | `ensureConversation` :234; `rememberMembership` :237; `beginSpawnRequest` :263; `settleSpawn` :766; `endHostlessSpawn` :967 | synchronous callback retained |
| `src/lib/links/testServer.ts` | `beginSpawnRequest` :221; `completeSpawn` :225; `rotateSpawnCapabilityForReceipt` :228; `rotateSpawnCapabilityForConversation` :242; `beginSpawnRequest` :255; `completeSpawn` :259; `rememberMembership` :266 | separate benchmark/fixture process; synchronous API retained |
| `src/lib/mcp/receiptStoreProbeChild.ts` | `holdDelivery` :137; `beginDeliveryAttempt` :147; `recordDeliveryOutcome` :154; `completeSpawn` :219 | separate benchmark/fixture process; synchronous API retained |
| `src/lib/monitor/seatTickSources.ts` | `recordDeliveryOutcomeForOperation` :622; `recordDeliveryOutcome` :628; `withdrawHeldDelivery` :722 | existing admission |
| `src/lib/orchestrator/deputyCommandPorts.ts` | `terminalizeHeldDelivery` :167 | existing admission |
| `src/lib/orchestrator/deputyCommandPorts.ts` | `ensureForkedConversation` :74 | synchronous callback retained |
| `src/lib/orchestrator/seatChannel.ts` | `recordDeliveryOutcome` :273; `withdrawHeldDelivery` :275; `settleDirectAdmission` :302 | existing admission |
| `src/lib/orchestrator/seatCommand.ts` | `retireUnconsumedSpawn` :392 | async admission in L7 |
| `src/lib/orchestrator/seatCommand.ts` | `stampOrchestratorSeatIdentity` :422 | synchronous callback retained |
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
| `src/lib/runtime/registry.ts` | `setStructuredHostClaimed` :188; `captureStructuredTerminationSurvivors` :249; `releaseStructuredHostClaim` :266; `terminateInactiveStructuredHost` :536; `captureStructuredTerminationSurvivors` :645; `withdrawStructuredTerminationSurvivors` :649; `settleStructuredTerminationSurvivors` :652; `claimStructuredHost` :750; `claimStructuredHost` :762; `setStructuredHostClaimed` :771 | synchronous callback retained |
| `src/lib/runtime/sendSettlement.ts` | `settleDeliveryRetryAttemptOffLoop` :1003; `recordDeliveryOutcomeForOperationOffLoop` :1013; `recordDeliveryOutcomeOffLoop` :1015; `recordDeliveryOutcomeForOperationOffLoop` :1022 | existing admission |
| `src/lib/runtime/startup.ts` | `reconcileConversations` :1488; `claimStructuredHost` :2269; `rotateSpawnCapabilityForPath` :2329; `rotateSpawnCapabilityForPath` :2397 | async admission in L7 |
| `src/lib/runtime/startup.ts` | `recordDirectAdmission` :1304; `settleDirectAdmission` :1355; `drainDeadSupersededHeldDeliveryCandidates` :2167 | existing admission |
| `src/lib/runtime/startup.ts` | `ensureConversation` :2308; `ensureConversation` :2378 | async admission in L7 |
| `src/lib/runtime/structuredControls.ts` | `releaseSwitchHold` :453; `withdrawConversationReconfigure` :463 | existing admission |
| `src/lib/runtime/structuredDeliveryController.ts` | `terminateInactiveStructuredHost` :1224; `recordStructuredTerminationSurvivors` :1273; `terminateStructuredHost` :1919; `terminateStructuredHost` :1926; `repairCompletedStructuredSpawnMarkers` :2010 | async admission in L7 |
| `src/lib/runtime/structuredDeliveryController.ts` | `recordDeliveryOutcomeForOperationOffLoop` :443; `recordDeliveryOutcomesForOperations` :480; `bindDeliveryBatchOffLoop` :912; `holdForFailedSwitch` :940; `bindDeliveryOperationGenerationOffLoop` :960; `recordDeliveryOutcomeForOperation` :1074; `failStructuredSpawnOffLoop` :1214 | existing admission |
| `src/lib/runtime/structuredDeliveryController.ts` | `recordStructuredTerminationSurvivors` :1262; `terminateStructuredHost` :1269; `markStructuredHostHandoff` :2481 | synchronous callback retained |
| `src/lib/runtime/structuredHostControl.ts` | `terminateStructuredHost` :443 | existing admission |
| `src/lib/runtime/structuredHostRetirement.ts` | `recordStructuredTerminationSurvivors` :1158 | synchronous callback retained |
| `src/lib/runtime/structuredMessageDelivery.ts` | `terminalizeHeldDelivery` :242; `holdDeliveryOffLoop` :732; `recordDeliveryOutcome` :1168; `terminalizeHeldDelivery` :1178; `holdDeliveryOffLoop` :1725; `requestConversationMigrationToActiveAccount` :1752; `retryUncertainDelivery` :1982; `terminalizeHeldDelivery` :1997; `recordDeliveryOutcomeOffLoop` :2061; `beginDeliveryAttemptOffLoop` :2066; `terminalizeHeldDelivery` :2087; `requeueHeldDelivery` :2122; `recordDeliveryOutcome` :2143; `recordDeliveryOutcome` :2160 | existing admission |
| `src/lib/runtime/structuredReconfigure.ts` | `terminateStructuredHost` :222; `terminateStructuredHost` :240; `terminateStructuredHost` :245; `terminateStructuredHost` :311; `terminateStructuredHost` :339; `terminateStructuredHost` :358 | async admission in L7 |
| `src/lib/runtime/structuredReconfigure.ts` | `claimConversationReconfigure` :135; `settleConversationReconfigure` :158; `requestConversationReseat` :276; `holdUndispatchedClaimsForSwitch` :286 | existing admission |
| `src/lib/runtime/structuredRecovery.ts` | `terminateStructuredHost` :434; `terminateStructuredHost` :600 | async admission in L7 |
| `src/lib/runtime/structuredRecovery.ts` | `beginSpawnRequestAsync` :468; `failSpawnOffLoop` :507; `failSpawnOffLoop` :515 | existing admission |
| `src/lib/runtime/structuredSpawn.ts` | `recoverStructuredSpawnFromEvidence` :728; `claimTmuxSpawnActuation` :893; `claimStartingStructuredSpawn` :894; `queuePinnedSpawn` :947; `releaseSpawnActuation` :952; `markSpawnPathPending` :990; `releaseSpawnActuation` :1020; `releaseSpawnActuation` :1026; `claimStructuredHost` :1644; `claimStructuredHost` :1691; `claimStructuredHost` :1705; `finalizeStructuredSpawn` :1738; `recoverDeliveredStructuredSpawn` :1750; `finalizeStructuredSpawn` :1793; `recoverStructuredSpawnFromEvidence` :2321; `recoverStructuredSpawnFromEvidence` :2428; `rotateSpawnCapabilityForReceipt` :2618; `setReceiptViewerMcpTransport` :2619; `setReceiptViewerMcpTransport` :2648; `stageStructuredSpawn` :2656; `claimStructuredHost` :2679; `releaseStructuredSpawnAdmissionOwner` :2771; `releaseStructuredSpawnAdmissionOwner` :2794; `finalizeStructuredSpawn` :2841; `releaseStructuredSpawnAdmissionOwner` :2868 | async admission in L7 |
| `src/lib/runtime/structuredSpawn.ts` | `recordDeliveryOutcome` :418; `recordDeliveryOutcome` :427; `failStructuredSpawnOffLoop` :520; `failStructuredSpawnOffLoop` :855; `failSpawnOffLoop` :857; `releaseSpawnActuation` :900; `admitRecoveredLaunch` :915; `failSpawnOffLoop` :1016; `backfillFailedLaunchReporting` :1087; `terminalizeAbandonedSpawnEntries` :1097; `failSpawnOffLoop` :1139; `failStructuredSpawnOffLoop` :1167; `failStructuredSpawnOffLoop` :1591; `failStructuredSpawnOffLoop` :1628; `failSpawnOffLoop` :1679; `failSpawnOffLoop` :1693; `failStructuredSpawnOffLoop` :1721; `failStructuredSpawnOffLoop` :2939; `failSpawnOffLoop` :2943; `releaseStructuredSpawnAdmissionOwner` :2958 | existing admission |
| `src/lib/runtime/structuredSpawn.ts` | `reportFailedLaunch` :1091 | existing single probe |
| `src/lib/runtime/structuredSpawn.ts` | `setStructuredHostClaimed` :1360; `releaseStructuredHostClaim` :1370; `preserveSpawnArtifactOwnership` :2255; `claimStructuredHost` :2578 | synchronous callback retained |
| `src/lib/telegram/bot/reportReplies.ts` | `withdrawHeldDelivery` :77 | existing admission |
| `src/lib/tmux.ts` | `rotateSpawnCapabilityForReceipt` :1311; `bindSpawnPane` :1342; `rotateSpawnCapabilityForReceipt` :1355; `markSpawnHostVerified` :1419; `invalidateSpawnHost` :1439; `invalidateSpawnHost` :1449; `invalidateSpawnHost` :1465; `markSpawnPromptDelivered` :1468 | async admission in L7 |
| `src/lib/tmux.ts` | `failSpawnOffLoop` :1548; `beginSpawnRequestAsync` :1556; `failSpawnOffLoop` :1569 | existing admission |
| `src/test-helpers/migrationDelivery.ts` | `reconcileConversations` :20; `upsert` :24; `holdDelivery` :54; `beginDeliveryAttempt` :56 | separate benchmark/fixture process; synchronous API retained |

## Synchronous callback exceptions

These are the remaining Viewer-reachable synchronous contracts. Their existing
semantics are preserved. Account-held and explicit Now paths already use zero
busy timeout; the other callbacks can still reach the synchronous sites. The
seat must check the 24-hour production target against these explicit exceptions.

| Caller | Methods and pinned lines | Why the synchronous contract remains |
| --- | --- | --- |
| `src/app/api/runtime/hosts/route.ts` | `recordStructuredTerminationSurvivors` :77 (callback) | The termination ladder requires synchronous capture acknowledgement before its first signal; changing it requires an awaited engine termination-capture protocol. |
| `src/lib/accounts/manager.ts` | `setEngineRouting` :547 (selectAccountLocked); `setEngineRouting` :552 (selectAccountLocked) | Account selection and rollback run inside the synchronous account mutation lock. accountMutationHeld makes registry acquisition a zero-timeout probe. |
| `src/lib/accounts/migration/coordinator.ts` | `transitionConversationMigration` :1012 (callback); `transitionConversationMigration` :1041 (callback); `rollbackConversationMigration` :1061 (callback); `transitionConversationMigration` :1068 (callback); `transitionConversationMigration` :1074 (callback); `transitionConversationMigration` :1087 (callback); `transitionConversationMigration` :1259 (callback) | The advance callback delegates to the existing offLoop admission helper; its mutation body already runs after asynchronous writer admission. |
| `src/lib/accounts/migration/provider.ts` | `stageSpawnCapabilityForConversation` :268 (successorCapability); `discardSpawnCapabilityForOperation` :275 (callback) | Successor capability creation returns both the grant and a synchronous restoration callback. Moving it requires the provider publication/rollback protocol to await both transitions. |
| `src/lib/agent/identityWaveStartup.ts` | `runIdentityWaveMigration` :189 (runIdentityWaveMigrationAtStartup) | The one-time migration has a synchronous startup retry callback and a multi-store account fence. Account-held registry probes already refuse without waiting; asynchronous startup rejection handling needs a separate callback contract change. |
| `src/lib/agent/spawnCommand.ts` | `reconcileConversations` :1218 (callback); `upsert` :1231 (callback) | The materialized-attempt callback reconciles transcript and host synchronously before publishing the same attempt. Awaiting each write requires a batch and renewed attempt custody checks. |
| `src/lib/agent/spawnParent.ts` | `ensureConversation` :49 (conversationForTranscript) | Lineage resolution synchronously creates a missing identity and returns admission evidence. An asynchronous resolver must repeat the provenance checks in its consumers. |
| `src/lib/agent/transcriptHost.ts` | `confirmSpawnPaneAlive` :642 (confirmRegistryHostAlive); `confirmSpawnPaneAlive` :708 (reconcileObservedTranscriptHosts); `confirmSpawnPaneAlive` :722 (reconcileObservedTranscriptHosts); `confirmSpawnPaneAlive` :744 (reconcileObservedTranscriptHosts); `completeObservedSpawn` :745 (reconcileObservedTranscriptHosts); `upsert` :782 (reconcileObservedTranscriptHosts); `markUnhosted` :794 (reconcileObservedTranscriptHosts); `reconcileSpawnReceipts` :797 (reconcileObservedTranscriptHosts); `ensureConversation` :841 (beginRegistryResume); `beginSpawnRequest` :851 (beginRegistryResume) | Reconciliation makes several writes from one host observation and synchronously returns quarantine decisions. Awaiting individual writes needs a transactional batch and renewed host evidence. Resume admission already runs under the account lock with zero-timeout probes. |
| `src/lib/conversation/transcriptAdmission.ts` | `reconcileConversations` :138 (admitTranscriptConversation) | The synchronous admission decision consumes the caller-supplied liveness observation. Moving its write needs a new asynchronous admission contract and a repeated authoritative liveness read. |
| `src/lib/flows/engine.ts` | `ensureConversation` :234 (commitReviewerSpawn); `rememberMembership` :237 (commitReviewerSpawn); `beginSpawnRequest` :263 (commitReviewerSpawn); `settleSpawn` :766 (settleReviewerSpawn); `endHostlessSpawn` :967 (endHeadlessReviewerMarker) | Reservation is a synchronous multi-store/account admission callback and already uses zero-timeout registry probes. Settlement and hostless-marker helpers synchronously update the mutable flow checkpoint; they need an awaited flow transition contract. |
| `src/lib/orchestrator/deputyCommandPorts.ts` | `ensureForkedConversation` :74 (callback) | Conversation registration returns an identity synchronously to the deputy command port. Moving it requires that port and its checkpoint consumers to await. |
| `src/lib/orchestrator/seatCommand.ts` | `stampOrchestratorSeatIdentity` :422 (callback) | Seat designation synchronously stamps registry identity before publishing the designation. Moving it requires an awaited designation contract. |
| `src/lib/runtime/registry.ts` | `setStructuredHostClaimed` :188 (callback); `captureStructuredTerminationSurvivors` :249 (callback); `releaseStructuredHostClaim` :266 (callback); `terminateInactiveStructuredHost` :536 (reconcileDeadStructuredRegistryHost); `captureStructuredTerminationSurvivors` :645 (callback); `withdrawStructuredTerminationSurvivors` :649 (callback); `settleStructuredTerminationSurvivors` :652 (callback); `claimStructuredHost` :750 (callback); `claimStructuredHost` :762 (callback); `setStructuredHostClaimed` :771 (callback) | Host state listeners, claim-release and termination-capture callbacks synchronously return durable ownership/boolean decisions before engine signalling. They require an awaited shared engine callback protocol; startup demotion callbacks are separately retried by their admit helper. |
| `src/lib/runtime/structuredDeliveryController.ts` | `recordStructuredTerminationSurvivors` :1262 (callback); `terminateStructuredHost` :1269 (callback); `markStructuredHostHandoff` :2481 (callback) | Termination capture and terminal callbacks must acknowledge persistence before signalling; demotion handoff marks the row before releasing ownership. Those callback contracts are synchronous. |
| `src/lib/runtime/structuredHostRetirement.ts` | `recordStructuredTerminationSurvivors` :1158 (callback) | The termination ladder requires a synchronous durable capture acknowledgement before its first signal; changing it requires the engine termination-capture callback protocol to await. |
| `src/lib/runtime/structuredSpawn.ts` | `setStructuredHostClaimed` :1360 (releaseAdoptionClaim); `releaseStructuredHostClaim` :1370 (releaseAdoptionClaim); `preserveSpawnArtifactOwnership` :2255 (writeStagedRecovery); `claimStructuredHost` :2578 (callback) | Adoption cleanup, staged recovery and the resume-claim callback synchronously transfer custody. Moving them requires awaited custody callbacks and renewed admission evidence. |

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

The synchronous store remains available to CLI/helper processes and the
callback exceptions above. This change does not claim that every synchronous
registry contract has become asynchronous.
