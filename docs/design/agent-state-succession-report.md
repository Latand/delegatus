# Successor verification report

Revision inspected before edits: `a4c5c7cee5a4bcb0babf98a6c23a3945c4ff0cdf`.
Scope: slice 1 succession custody, Claude prompt identity and background evidence cost. Later slices and heap work remain deferred.

## Enumeration recorded before implementation

| Planned succession path | Existing custody at the inspected revision | Required handling |
| --- | --- | --- |
| Active Claude turn in `releaseStructuredDeliveryHostsForDemotion` | Two health reads admit an event wait under the original process/claim. Background wait runs only when both reads are active. | One custody loop must cover active, idle and transitions; revalidate process and claim after every await. |
| Already idle Claude with unfinished child | Skips the active block; handoff records interruption then `release` ends the tree. Custody fails. | Retain stdio broker and child through background completion and terminal delivery. |
| Foreground completes between the first and second health reads | Second-active condition fails, bypassing background wait. Custody fails. | Same loop as the idle path; health snapshots cannot bypass custody. |
| Foreground ends during event wait; background result starts a new turn | Existing wait uses foreground end then transcript polling. It can observe task completion before the broker has delivered its result. | Continue until background facts and the current broker turn/event delivery agree. |
| `handOverHostForDemotion` / registered and unpublished launch release callbacks | Handoff validates row/claim and evidence; continuation alone permits process termination. Both registration kinds share demotion. | Both must pass the same custody mechanism immediately before handoff/release. |
| Old owner exits; `claimStructuredHost`, `adoptClaudeRegistryHosts`, `structuredSpawn` | Claim refuses a living stdio process; no pipes can be reconnected. Adoption generally preserves it. | Preserve live work; never create a competing native process. |
| Shared registry stop: `stopSettledOrphanForPendingDelivery` → `terminateVerifiedStructuredOrphan` → `endRecordedStructuredTree` | Checks central settled-turn/owner/attention/obligation projection and transcript signature; foreground closure alone does not prove background completion. | Require verified background absence and retain that file version through every signal callback. |
| Skipped registry demotion and terminal orphan recovery | Existing live-stdio protection and owner/process guards preserve living work; dead-root cleanup captures descendants. | Keep protections and proven-dead-root descendant cleanup. |
| Broker release and checkpoint/adoption cleanup | Explicit release reaps its recorded tree. Failure/explicit stop are separate operation policies. | Planned succession must establish custody before calling release; preserve typed cleanup failures. |

Native prompt anchor contract and all producers/consumers:

| Site | Existing behaviour / disposition |
| --- | --- |
| Broker send and queue advance | Local queue entry ref identifies the held turn; next delivery's confirmed native UUID seeds the anchor. Preserve distinction. |
| Broker user-frame handler | Every user UUID overwrites `agentStateNativePromptId`, including tool output and steering echoes. Fails prompt identity. Use the shared prompt definition and the opening delivery's identity. |
| Broker `startBackgroundTurn` | Seeds background turn from associated `user_message_uuid`. Keep its correlation to native opening. |
| Broker `currentState` / `agentStateMemory` | Expose native UUID separately from local ref; `acceptAgentStateTerminal` consumes it. Preserve. |
| `claudeHostColumns`, binding checkpoints, registry normalization/copies and `entryRevision` | Persist/copy/invalidate `agentStateNativeTurnId`; no new independent identity inference. Preserve. |
| `nativeBoundaryEvent` for native transcript | Tool-result user frames are outputs; interrupt/compact records have separate qualifiers. Reuse this prompt qualification for live and ledger paths. |
| `nativeBoundaryEvent` for Claude host ledger | Every user item is treated as a start, so fallback picks tool output's UUID. Fails. Share native prompt qualification; retain the first opening for a local ref. |
| `AgentTranscriptCache` / `AgentStateService` correlation | Native terminal must match cached UUID or ledger opening; unknown correlation retains the ref. Preserve newer prompt/claim/revision protection. |
| Guarded registry repair / journal / runtime publication | Repair clears exact matching stale cache, journals divergence and publishes convergence. Preserve transaction and restart fences. |
| Delivery ledger replay matching, `activeUserUuid`, joined steering UUIDs, restart-cut frame-before/after evidence | Protocol/delivery identities also track user frames. They must retain their existing delivery semantics; the prompt anchor remains a separate opening identity. |

Background readers: `verifiedBackgroundWork` is shared by restart-cut/custody; it currently rescans the whole file. Keep its strict integrity refusals and introduce a bounded shared version cache with incremental suffix folding. The permissive legacy `readBackgroundTaskLedger` is unsuitable for authorizing termination.

Prior evidence: retained manifest and review transcript confirm all three findings; scoped and unscoped memory searches found no reusable alternative repair. Parallel diffs for PRs #3970 and #3982 inspected; their registry/termination decision work remains separate. Reuse the existing broker succession child fixture and retained reproductions.

### Startup inventory correction

The initial enumeration conflated unpublished launch handles with startup's separate retained handles. Final inventory review found these additional release paths after the first committed implementation passed its pre-push hook. They were enumerated before their repair and exercised against the earlier implementation:

| Startup path | Custody before the additional repair | Required handling |
| --- | --- | --- |
| `releaseUnpublishedStartupHostsForDemotion` | Calls handoff and broker release directly for adopted/retry handles that have no controller registration. An idle background child can still be killed. | Enter the same Claude custody and release boundary as registered and unpublished launch hosts. |
| `revalidateRetainedStartupHosts` | A terminal or superseded conversation releases its retained handle directly. Foreground status does not establish background completion. | Preserve custody through completion and delivery before releasing; forget the released handle from every retained startup set. |

Both paths now call `releaseClaudeHostForDemotion`. Its only custody loop remains `settleClaudeWorkBeforeDemotion`; callers retain their existing identity-bound release and stop-origin policies. Startup regressions pause the real adoption pass after retaining a broker, before registration, then exercise both release paths with a separate unfinished tool process.

The delivery-order inventory also includes demotion starting after a native background terminal is written, before its first broker result arrives. A file-only initial check cannot prove delivery in that window. The broker now retains one last-delivered native opening in memory; the common custody loop compares it with the native boundary before authorizing release. Claude alone produces this optional host-memory fact; custody consumes it, the other engines omit it, and registry persistence and reconciliation do not copy it.

That memory fact distinguishes a broker that has never ended a turn from one that ended an unidentified turn. Once a broker has ended a turn, a missing or empty native artifact refuses release. Restoration permits the same pending job to finish without rerunning it. Retained startup cleanup also passes its existing lifetime guard into custody, so cancellation and the startup deadline keep their authority during the wait.

## Implementation and scope

The common demotion custody loop now covers an already idle host, a foreground transition during health reads, native self-started work, and terminal delivery after a background notification. It preserves the original process, claim epoch and artifact identity after asynchronous reads, under one expiry. A refused stream records the owed interruption and preserves the live tree. Successful Claude releases run immediately against the expected registration after custody, so waiting for a sibling host cannot invalidate the completed check.

Implementation references: `src/lib/runtime/structuredDeliveryController.ts:3010` and `:3144`, retained startup cleanup at `src/lib/runtime/startup.ts:244` and demotion at `:3759`, `src/lib/runtime/registry.ts:840`, `src/lib/claudeProtocolUser.ts:160`, `src/lib/pipelines/backgroundTasks.ts:439`, and the real broker-owner restart at `src/lib/agentState/restart.test.ts:47`.

All shared orphan recovery callers now require verified background absence for a living Claude root, pinned through each stop callback. This also closes the terminal-status path identified during implementation review. Proven-dead-root descendant cleanup retains its existing authority.

`isClaudePrompt` supplies prompt qualification for host memory, native boundaries and ledger fallback. The held turn retains its opening identity across tool output and joined deliveries. Ledger recovery reads back to that local turn's opening boundary. Reconciliation keeps its existing guarded repair, journal and newer-prompt fences.

Delivered task notifications that request a provider turn retain their own native opening. The work-duration metadata classifier has a separate purpose, so its task-notification exclusion is qualified explicitly here.

The strict background cache retains at most 64 summaries, bounds each serialized summary to 128 Ki UTF-16 units and each suffix acquisition to 4 MiB plus at most 512 overlap bytes, folds changed suffixes, evicts least recently used rows and refuses incomplete or invalid evidence. It verifies file identity, size, nanosecond modification/change times and append overlap. Native boundary polling uses the existing transcript cache.

The one-hour idle retirement policy, its environment override, event-window hotfix and startup behavior are preserved. Slices 2–5, heap attribution, parallel pipeline-termination work and deployment remain outside this change.

Regression sources reuse `src/lib/runtime/fixtures/claudeBackgroundSuccessionChild.ts`. Separate broker-owner, native engine, successor scheduler and tool processes exercise restart and custody; no provider request or live installation is involved.

## Verification

The retained reproductions were run first on the published input, one file per private gate command:

| Command | Exit | Pass | Fail | Assertions |
| --- | ---: | ---: | ---: | ---: |
| `bun test --timeout=60000 src/lib/runtime/review-idle-background.test.ts` | 1 | 0 | 1 | 6 |
| `bun test --timeout=60000 src/lib/runtime/review-correlation.test.ts` | 1 | 0 | 1 | 2 |
| `bun test --timeout=60000 src/lib/runtime/review-background-cost.test.ts` | 1 | 0 | 1 | 7 |

These scratch source names refer to the retained review reproductions. The committed successors are `src/lib/runtime/claudeSuccession.test.ts`, `src/lib/agentState/restart.test.ts`, `src/lib/agentState/transcript.test.ts` and `src/lib/pipelines/backgroundTasks.test.ts`.

Checks run through the supplied `scripts/gate-slot.sh`, with a separate HOME, XDG config, temporary root and state directory per file and the Viewer control URL on a closed local port. Full command outputs, actual statuses and counts are retained by the delivery stage. The post-commit hook receipt is recorded in the final delivery report.


## Command and count record

Every test row expands to `bun test --timeout=60000 <path>` through the supplied gate. Cells show `exit; pass/fail/skip`. The first two columns retain intermediate results; the last column is the completed functional verification.

| Test path | Iteration 1 | Iteration 2 | Verified |
| --- | ---: | ---: | ---: |
| `src/lib/runtime/claudeSuccession.test.ts` | 0; 8/0/0 | 1; 10/3/0 | 0; 13/0/0 |
| `src/lib/pipelines/backgroundTasks.test.ts` | 1; 19/1/0 | 0; 20/0/0 | 0; 20/0/0 |
| `src/lib/agentState/transcript.test.ts` | 0; 22/0/0 | 0; 22/0/0 | 0; 23/0/0 |
| `src/app/api/operator/agent-state/route.test.ts` | 0; 2/0/0 | 0; 2/0/0 | 0; 2/0/0 |
| `src/lib/accounts/migration/turnState.test.ts` | 0; 46/0/0 | 0; 46/0/0 | 0; 46/0/0 |
| `src/lib/agent/registry.test.ts` | 0; 139/0/0 | 0; 139/0/0 | 0; 139/0/0 |
| `src/lib/agentState/model.test.ts` | 0; 2/0/0 | 0; 2/0/0 | 0; 2/0/0 |
| `src/lib/agentState/restart.test.ts` | 0; 3/0/0 | 0; 4/0/0 | 0; 4/0/0 |
| `src/lib/agentState/service.test.ts` | 0; 26/0/0 | 0; 26/0/0 | 0; 26/0/0 |
| `src/lib/agentState/store.test.ts` | 0; 6/0/0 | 0; 6/0/0 | 0; 6/0/0 |
| `src/lib/resources.structuredHosts.test.ts` | 0; 10/0/0 | 0; 10/0/0 | 0; 10/0/0 |
| `src/lib/runtime/claudeStreamBrokerHost.test.ts` | 0; 198/0/0 | 1; 195/3/0 | 0; 199/0/0 |
| `src/lib/runtime/codexAppServerHost.test.ts` | 0; 384/0/0 | 0; 384/0/0 | 0; 384/0/0 |
| `src/lib/runtime/copilotAcpHost.test.ts` | 0; 47/0/0 | 0; 47/0/0 | 0; 47/0/0 |
| `src/lib/runtime/liveness.test.ts` | 0; 76/0/0 | 0; 76/0/0 | 0; 76/0/0 |
| `src/lib/runtime/structuredHostControl.history.test.ts` | 0; 2/0/0 | 0; 2/0/0 | 0; 2/0/0 |
| `src/lib/runtime/structuredHostControl.test.ts` | 0; 50/0/0 | 0; 50/0/0 | 0; 50/0/0 |
| `src/lib/runtime/structuredHostRetirement.test.ts` | 0; 88/0/0 | 0; 88/0/0 | 0; 88/0/0 |
| `src/lib/runtime/hostEventWindow.test.ts` | 0; 25/0/0 | 0; 25/0/0 | 0; 25/0/0 |
| `src/lib/runtime/idleHostEventWindow.test.ts` | 0; 13/0/0 | 0; 13/0/0 | 0; 13/0/0 |
| `src/lib/runtime/startupIdleHosts.test.ts` | 0; 3/0/0 | 0; 3/0/0 | 0; 3/0/0 |
| `src/app/api/operator/heap/route.test.ts` | 0; 8/0/0 | 0; 8/0/0 | 0; 8/0/0 |
| `src/lib/heapAttribution.test.ts` | 0; 5/0/0 | 0; 5/0/0 | 0; 5/0/0 |
| `src/lib/runtime/engineHostEvents.test.ts` | 0; 27/0/0 | 0; 27/0/0 | 0; 27/0/0 |
| `src/lib/runtime/structuredDeliveryController.test.ts` | 0; 25/0/0 | 0; 25/0/0 | 0; 25/0/0 |
| `src/lib/viewerInstrumentation.test.ts` | 0; 12/0/0 | 0; 12/0/0 | 0; 12/0/0 |
| `src/lib/runtime/registryPersistence.test.ts` | 0; 92/0/0 | 0; 92/0/0 | 0; 92/0/0 |
| `src/lib/runtime/releaseInterruption.test.ts` | 1; 145/8/1 | 1; 146/7/1 | 1; 146/7/1 |

The verified run contains **1,493 pass, 7 known baseline failures and 1 skip across 28 files**. The 27 green files contain 1,347 passes. `releaseInterruption.test.ts` retains exactly the seven baseline failure names and assertions (146 pass, 7 fail, 1 skip); the verification driver compares that set with the retained baseline and refuses new failures. The previously green suites remain green.

Subsequent review added a fourteenth succession case: it holds all 64 background-read slots, starts demotion, releases the readers, and requires the same job's result once. Capacity deferrals now retry under the original custody deadline. The first unmodified post-commit hook checks that case; later class controls are recorded below.

Other check commands and controls:

| Command / control | Exit | Counts |
| --- | ---: | --- |
| `bun test --timeout=60000 src/lib/runtime/claudeSuccession.test.ts` | 1 | 3 pass, 3 fail, 0 skip, 0 filtered |
| `bun test --timeout=60000 src/lib/runtime/claudeSuccession.test.ts` | 0 | 6 pass, 0 fail, 0 skip, 0 filtered |
| `bun test --timeout=60000 src/lib/runtime/claudeSuccession.test.ts` | 0 | 13 pass, 0 fail, 0 skip, 0 filtered |
| `bun test --timeout=60000 src/lib/runtime/releaseInterruption.test.ts --test-name-pattern "failed demotion cleanup keeps the obligation"` (published input) | 0 | 1 pass, 0 fail, 0 skip, 153 filtered |
| `bun test --timeout=60000 src/lib/runtime/claudeStreamBrokerHost.test.ts --test-name-pattern "terminal-row orphan stop\|writer that outlives"` (published input) | 0 | 3 pass, 0 fail, 0 skip, 195 filtered |
| `bunx tsc --noEmit --incremental false` (initial) | 2 | 1 missing test argument diagnostic |
| `bun node_modules/typescript/bin/tsc --noEmit --incremental false` (intermediate and verified) | 0, 0 | 0 diagnostics |
| `bun node_modules/eslint/bin/eslint.js --no-cache <51 changed TypeScript/JavaScript paths>` | 0 | 0 errors, 9 warnings before removal of one new unused argument |
| `bun node_modules/eslint/bin/eslint.js --no-cache src/lib/runtime/registry.ts` | 0 | 0 errors, 0 warnings after the annotation cleanup |

The unused argument was removed with a type annotation; its direct lint and the final commit hook are recorded in the delivery receipt. The hook and pinned design are unmodified. `git diff --check` and the `git fetch origin main` observations exited 0. Main remained an ancestor, so no merge was needed. No branch switch or push was performed.

## Repeated background read measurement

Command: `bun background-cost.probe.ts <private-data-root>`, under the gate, in a fresh process and private state for every sample. The probe source and raw records are retained with the stage evidence. Each process checks two file versions twice. Both revisions use identical synthetic records: version sizes 4,231,382 and 4,231,573 bytes, with matching SHA-256 digests in every sample. This measures FileHandle payload bytes. No latency or resident-memory gain is claimed.

| Revision / sample | Exit | Observations | Cold bytes | Unchanged bytes | Terminal suffix + overlap | Unchanged terminal version | Total bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Published input / 1 | 0 | 4 | 4,231,382 | 4,231,382 | 4,231,573 | 4,231,573 | 16,925,910 |
| Published input / 2 | 0 | 4 | 4,231,382 | 4,231,382 | 4,231,573 | 4,231,573 | 16,925,910 |
| Candidate / 1 | 0 | 4 | 4,232,218 | 0 | 703 | 0 | 4,232,921 |
| Candidate / 2 | 0 | 4 | 4,232,218 | 0 | 703 | 0 | 4,232,921 |

In both candidate samples the unchanged versions read **zero payload bytes**. The 191-byte terminal append costs 703 bytes including overlap validation, clears the pending fact, and the real broker custody regression waits through delivery of its result before release.

Final privacy, commit and unmodified pre-push receipts are attached to the delivery report after the commit exists. All raw output, wrapper cleanup evidence, exact invocation arguments and statuses remain retained locally.

### Additional class controls

| Command | Exit | Counts / result |
| --- | ---: | --- |
| `bash .githooks/pre-push` on the first successor commit | 0 | Types, ESLint, privacy, touched tests and scoped Linux gates pass; comparator: 0 new failures, 25 pre-existing, 3 flaky. Includes the cache-saturation regression. |
| `bun test --timeout=60000 src/lib/runtime/claudeSuccession.test.ts -t startup-retained` before the startup repair | 1 | 0 pass, 2 fail, 14 filtered, 8 assertions; pending-work assertions fail. Revalidation setup is corrected below. |
| `bun test --timeout=60000 src/lib/runtime/claudeSuccession.test.ts` after startup repair | 1 | 15 pass, 1 fail, 107 assertions; demotion passes, revalidation fixture had an invalid supersedence shape. |
| `bun test --timeout=60000 src/lib/runtime/claudeSuccession.test.ts -t 'start-after-native\|startup-retained'` before the delivery-order repair | 1 | 2 pass, 1 fail, 14 filtered, 23 assertions; corrected startup cases pass, native-terminal-ahead-of-delivery control fails. |
| `bun test --timeout=60000 src/lib/runtime/claudeSuccession.test.ts -t 'startup-retained.*revalidation'` on the first successor commit with corrected fixtures | 1 | 0 pass, 2 fail, 17 filtered, 8 assertions; the original retained cleanup releases pending work. |
| `bun test --timeout=60000 src/lib/runtime/claudeSuccession.test.ts` with polluted-anchor and cancellation cases | 0 | 19 pass, 0 fail, 143 assertions. |
| `bun node_modules/typescript/bin/tsc --noEmit --incremental false` after the shared-boundary extraction | 2 | 1 diagnostic: the controller's nullable registry did not fit the helper signature; the helper now accepts the same nullable input. |
| `bun test --timeout=60000 src/lib/runtime/claudeSuccession.test.ts -t 'native artifact refuses release'` on the first successor commit | 1 | 0 pass, 2 fail, 19 filtered, 2 assertions; missing and empty artifacts incorrectly permit release. |
| `bun test --timeout=60000 src/lib/runtime/claudeSuccession.test.ts` with artifact refusal and recovery cases | 1 | 20 pass, 1 fail, 151 assertions; a terminal append during recovery triggers a version-change refusal. |
| `bun test --timeout=60000 src/lib/runtime/claudeSuccession.test.ts` with deterministic append interleavings | 0 | 21 pass, 0 fail, 155 assertions. |
| `bun node_modules/typescript/bin/tsc --noEmit --incremental false` after the nullable-input fix | 0 | 0 diagnostics. |
| Touched runtime ESLint, invocation below | 0 | 0 errors, 2 unchanged warnings. |

The additional delivery-order case holds the native process after its terminal append and before its broker output, begins demotion in that window, and then permits delivery. It requires one job start, one delivered result and one background terminal, using the same broker fixture.

Anchor recovery also covers an existing checkpoint polluted with a tool-result UUID, alongside the valid checkpoint and missing-anchor cases. The shared ledger reader recovers the opening prompt; convergence records one divergence and still protects a newer prompt.

The renewed 28-file campaign after the startup and delivery-order repairs exits 0: **1,497 pass, 7 known baseline failures, 1 skip**. Every row in the last table column keeps its status and counts except `claudeSuccession.test.ts`, which now has 17 passes. The baseline file again has exactly 146 pass, 7 fail and 1 skip, with matching retained failure names; the other 27 files contain 1,351 passes. Later focused checks below add polluted-anchor, startup-cancellation and native-artifact refusal cases.

Restoration now forces a terminal append after the reader captures its initial file stat. Custody retries temporary version changes, incomplete appends, page recovery and cache capacity under the same deadline. It retains the last deferred-read cause if that deadline expires; owner or artifact replacement still refuses immediately.

After merging the newer main, renewed verification passed all 21 focused succession cases and found one failure in the older active-broker fixture: it emitted its stream result without creating any native transcript. The reused child fixture now writes its actual opening and terminal in that mode too. Missing-artifact refusal remains covered by the focused suite; no production guard is relaxed. The renewed per-command counts and final hook receipt are retained in the delivery report.

The first hook on the merged repair exposed ten startup differences. Before the additional repair, the shared-path inventory is: `addStructuredRestartConversation` in `startupRecipient.fixture.ts` is the sole synthetic transcript writer/default used by `startup.test.ts`; its default omits the final newline, while explicit suffixes also supply torn-record cases. `releaseHandoverIncumbent.ts` has two callers in that suite, for normal and deliberately skipped release; its active fake host never delivers a terminal. The older bounded-tail Codex assertion expects an unanswered tool to override a matching native completion. Finally, the pending-delivery orphan recovery helper feeds both Codex and Claude adoption, including claim retries: its settled-turn precondition also blocks cleanup of a proven-dead root with recorded descendants. Complete fixture records must use the native writer's newline, explicit torn suffixes must remain, the normal incumbent must settle before demotion, the Codex completion must stay settled, and proven-dead roots must reach the existing captured-tree ladder. Living roots retain the background custody fence.

The final anchor audit also checks the effect of every non-prompt frame on a completed turn. Host memory and ledger fallback ignore those frames; the native boundary reader still emits a generic continuation for metadata, which reopens the prior completed turn. The shared prompt qualifier must make that reader ignore the frame too. The six existing non-prompt cases now check the completed-turn verdict as well as anchor qualification.

### Delivery continuation command record

`git fetch origin main` and the merge command exit 0. The merge preserves the repair files; both private checkouts install their own dependencies with `bun install --frozen-lockfile` (exit 0, 543 packages each). The active child fixture correction commits through the canonical hook (exit 0, zero lint errors). An initial scratch checkout refuses two copied edits (exit 1, no effect); restoring those owned copies and checking out the committed revision exits 0. No scratch commit is created.

Every test command below is `bun test --timeout=60000 <path> [selection]`, through the supplied gate and fresh private state. Repeated rows preserve intermediate failures. The 27 green files in the renewed named campaign contain 1,355 passes; their rows above retain their counts, with the succession file increased to 21 passes. The interruption runs below are separate from those green files.

| Path / selection and source | Exit | Pass / fail / skip | Assertions or filters |
| --- | ---: | ---: | --- |
| `src/lib/runtime/claudeStreamBrokerHost.test.ts`, first merged run | 1 | 198 / 1 / 0 | 3,488 assertions; absent native artifact in the active fixture |
| Same path, `-t "planned succession preserves an active"`, published input | 0 | 1 / 0 / 0 | 14 assertions, 197 filtered |
| Same full path, corrected fixture | 0 | 199 / 0 / 0 | 3,494 assertions |
| `src/lib/runtime/releaseInterruption.test.ts`, renewed head | 1 | 145 / 8 / 1 | 823 assertions; seven known failures and a busy-lock failure |
| Same full path, published input confirmation | 1 | 146 / 7 / 1 | 825 assertions |
| Same full path, head confirmation | 1 | 145 / 8 / 1 | 822 assertions; lock case passes, a different probe timing case fails |
| `src/lib/runtime/startup.test.ts`, diagnostic | 1 | 184 / 15 / 0 | 818 assertions; five main failures and ten differences |
| Same path, `-t "D1 records the seat cut"`, input dead-root control, twice | 1 each | 0 / 1 / 0 each | 4 assertions, 198 filtered each |
| Same full path, first startup repair | 1 | 191 / 8 / 0 | 861 assertions |
| Same full path, second startup repair | 1 | 193 / 6 / 0 | 868 assertions; five main failures and the incomplete handover fixture |
| Same path, `-t "a target-first hand-over"`, missing runtime-session control | 1 | 1 / 1 / 0 | 44 assertions, 197 filtered |
| Same path and selection, complete queued-operation fixture | 0 | 2 / 0 / 0 | 56 assertions, 197 filtered; one delivery |
| `src/lib/agentState/transcript.test.ts`, `-t "Claude native and ledger readers exclude"`, prior-repair adapter | 1 | 3 / 3 / 0 | 18 assertions, 17 filtered; metadata reopens completion |
| Same full path, final adapter | 0 | 23 / 0 / 0 | 72 assertions |
| `src/lib/agentState/restart.test.ts` | 0 | 4 / 0 / 0 | 74 assertions |
| `src/lib/agentState/service.test.ts` | 0 | 26 / 0 / 0 | 82 assertions |
| `src/lib/accounts/migration/turnState.test.ts` | 0 | 46 / 0 / 0 | 59 assertions |
| `src/lib/runtime/claudeSuccession.test.ts` | 0 | 21 / 0 / 0 | 155 assertions |
| `src/lib/runtime/agentScope.test.ts` | 0 | 57 / 0 / 15 | 204 assertions |

The final focused positive commands contain 378 passes, zero failures and 15 platform skips; the expected metadata control is counted separately. That batch spends about 15 minutes in CPU admission before execution. The seven interruption baseline failures match both names and assertions: each expects two continuations and receives one. The first unmodified hook on the merged repair exits 1: ten new startup failures, 30 pre-existing, one fixed and two flaky; its types, lint and Linux peers are cancelled and judge nothing. The final hook receipt belongs to the post-commit delivery report and runs on the eventual committed tree.

Touched runtime ESLint invocation:

```sh
bun node_modules/eslint/bin/eslint.js --no-cache \
  src/lib/runtime/claudeStreamBrokerHost.ts \
  src/lib/runtime/claudeSuccession.test.ts \
  src/lib/runtime/engineHost.ts \
  src/lib/runtime/fixtures/claudeBackgroundSuccessionChild.ts \
  src/lib/runtime/startup.ts \
  src/lib/runtime/structuredDeliveryController.ts
```


Full ESLint invocation for the 51-path run:

```sh
bun node_modules/eslint/bin/eslint.js --no-cache \
  src/app/api/operator/agent-state/route.test.ts \
  src/app/api/operator/agent-state/route.ts \
  src/lib/accounts/migration/turnState.test.ts \
  src/lib/accounts/migration/turnState.ts \
  src/lib/agent/registry.test.ts \
  src/lib/agent/registry.ts \
  src/lib/agent/sqliteRegistryStore.ts \
  src/lib/agentState/index.ts \
  src/lib/agentState/invalidation.ts \
  src/lib/agentState/model.test.ts \
  src/lib/agentState/model.ts \
  src/lib/agentState/nativeTurnState.ts \
  src/lib/agentState/process.ts \
  src/lib/agentState/projectionCache.ts \
  src/lib/agentState/restart.fixture.ts \
  src/lib/agentState/restart.test.ts \
  src/lib/agentState/service.test.ts \
  src/lib/agentState/service.ts \
  src/lib/agentState/store.test.ts \
  src/lib/agentState/store.ts \
  src/lib/agentState/testFixture.ts \
  src/lib/agentState/transcript.test.ts \
  src/lib/agentState/transcript.ts \
  src/lib/claudeProtocolUser.ts \
  src/lib/pipelines/backgroundTasks.test.ts \
  src/lib/pipelines/backgroundTasks.ts \
  src/lib/resourceWorkerRequest.ts \
  src/lib/resources.structuredHosts.test.ts \
  src/lib/resources.ts \
  src/lib/runtime/claudeStreamBrokerHost.test.ts \
  src/lib/runtime/claudeStreamBrokerHost.ts \
  src/lib/runtime/claudeSuccession.test.ts \
  src/lib/runtime/codexAppServerHost.test.ts \
  src/lib/runtime/codexAppServerHost.ts \
  src/lib/runtime/copilotAcpHost.test.ts \
  src/lib/runtime/copilotAcpHost.ts \
  src/lib/runtime/engineHost.ts \
  src/lib/runtime/fixtures/claudeBackgroundSuccessionChild.ts \
  src/lib/runtime/liveness.test.ts \
  src/lib/runtime/liveness.ts \
  src/lib/runtime/registry.ts \
  src/lib/runtime/structuredDeliveryController.ts \
  src/lib/runtime/structuredHostControl.history.test.ts \
  src/lib/runtime/structuredHostControl.test.ts \
  src/lib/runtime/structuredHostControl.ts \
  src/lib/runtime/structuredHostRetirement.paging.fixture.ts \
  src/lib/runtime/structuredHostRetirement.test.ts \
  src/lib/runtime/structuredHostRetirement.ts \
  src/lib/types.ts \
  src/lib/viewerInstrumentation.ts \
  src/lib/viewerLoopMonitor.ts
```
