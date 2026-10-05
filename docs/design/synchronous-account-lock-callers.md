# Synchronous account mutation admission

The original brief identifies 29 call sites. This inventory records their final
foreign-holder and same-process policies. Withdrawal and compatibility routing
now acquire asynchronously; the synchronous store methods retain their return
contracts. The async request/command boundaries queue small commits and enter
those methods reentrantly.

A foreign holder gets at most **25 ms of synchronous admission waiting per
top-level acquisition**, including caller-supplied budgets. Filesystem and
existing critical-section execution add their own elapsed time. A local holder
or local waiter must run on the event loop, so a synchronous API cannot wait for
it. It either enters an inherited active transaction, delegates to the async
boundary listed below, uses its existing coalesced/keyed replay, or returns the
explicit safe busy response listed below. No mutation is scheduled in the
background after a synchronous API refuses admission.

Async request/command admission waits 2 s by default with a named caller; seat
activation retains its 10 s budget. Keyed seat/rotation replay retains three
replays within 10 s. These waits yield. No provider probe, fork, delivery,
withdrawal socket call, digest calculation or handoff summarizer moved under
the lock.

| Caller | File:line | Foreign holder | Why | Local holder or local waiter |
| --- | --- | --- | --- | --- |
| `runIdentityWaveMigrationAtStartup` | `src/lib/agent/identityWaveStartup.ts:196` | 25 ms wait | Boot needs a completed migration result; rerunning the outer startup later remains idempotent. | Safe busy exception aborts startup; the next startup retries the idempotent migration. A synchronous boot cannot yield for its own holder. |
| `recordSpawnAdmissionRejection` | `src/lib/agent/spawnAdmission.ts:224` | 25 ms foreign wait; async request queue | The refusal fence must commit before its result is returned; deferred writing could race reservation. | Spawn refusal and validation await async admission (2 s), then commit reentrantly; they return only after the durable fence or an explicit unfenced outcome. |
| `beginSpawnRequest` | `src/lib/agent/registry.ts:5434` | 25 ms wait | Returns a durable reservation or rejection synchronously; request paths already have async admission. | Request paths use beginSpawnRequestAsync / async admission; direct sync API raises safe AccountMutationBusyError, with no reservation. Caller must retry after yielding. |
| `runIdentityWaveMigration` | `src/lib/agent/registry.ts:5894` | 25 ms wait | The migration and its marker return together; no detached replay may claim completion. | Startup raises safe AccountMutationBusyError and retries on the next startup; no completion marker is written on refusal. |
| `setEngineRouting` | `src/lib/agent/registry.ts:7960` | 25 ms wait | The caller needs the committed routing revision. | Account manager selection already queues asynchronously; direct sync API raises safe AccountMutationBusyError without changing the routing revision. |
| `retireAccount` | `src/lib/agent/registry.ts:7995` | 25 ms wait | Removal needs the committed retirement report before continuing its journal. | Safe AccountMutationBusyError before retirement commits; removal/recovery must retry after yielding with fresh ownership evidence. No retirement result is returned. |
| `rewriteAccountPaths` | `src/lib/agent/registry.ts:8064` | 25 ms wait | Rollback needs the path rewrite count before advancing recovery. | Safe AccountMutationBusyError without a rewrite result. Recovery retries after yielding and re-reading the journal; no path rewrite is scheduled after refusal. |
| `commitMigrationIntent` | `src/lib/agent/registry.ts:8100` | 25 ms wait | The returned intent must honor the expected routing revision under the lease. | Safe AccountMutationBusyError without committing an intent; caller retries after yielding with a fresh expected routing revision. |
| `restoreSnapshot` | `src/lib/agent/registry.ts:9189` | 25 ms wait | Restores only owned changes against the supplied snapshot; detached replay would use stale evidence. | Safe AccountMutationBusyError without restoring a snapshot; caller retries after yielding and re-reading the ownership snapshot. |
| `reconcileCompletedSeatReplay` | `src/lib/orchestrator/seatCommand.ts:563` | 25 ms wait; outer request replay | Authority projection needs a synchronous seat snapshot. Longer contention replays the keyed request. | Creation/rotation yield and replay the same request (three replays, 10 s total); exhaustion returns safe retryable 503. No launch precedes this reconciliation. |
| `beginOrchestratorSeatIntent` | `src/lib/orchestrator/seats.ts:781` | 25 ms wait; outer request replay | The epoch and pending intent must be durable before launch or delivery. | Keyed seat/rotation request replay yields; async activation is separate. Exhaustion returns safe retryable 503 without a new launch. |
| `completeOrchestratorSeatIntent` | `src/lib/orchestrator/seats.ts:861` | 25 ms wait; async activation | Seat completion returns one atomic authority transfer. Activation already queues asynchronously after acceptance. | Async activation queues (10 s); an accepted launch is retained on exhaustion. Direct sync API raises safe AccountMutationBusyError. |
| `repairOrchestratorSeatRuntimeIdentity` | `src/lib/orchestrator/seats.ts:931` | 25 ms wait; outer request replay | Projection repair returns the current seat under the lease. | Reentrant during async activation; otherwise keyed seat/rotation replay yields. Direct sync API raises safe AccountMutationBusyError. |
| `failOrchestratorSeatIntent` | `src/lib/orchestrator/seats.ts:969` | 25 ms wait | A terminalization result must describe the record actually written. | Safe AccountMutationBusyError if terminalization cannot enter; guard returns retryable 503 and preserves the pending/accepted intent for reconciliation. |
| `abandonStillbornOrchestratorSeat` | `src/lib/orchestrator/seats.ts:1035` | 25 ms wait; rotation replay | The rollback must recheck materialization and ownership; rotation retries its reconciliation before composing. | Keyed creation/rotation replay yields before handoff side effects; direct sync API raises safe AccountMutationBusyError. |
| `confirmOrchestratorSeatMaterialization` | `src/lib/orchestrator/seats.ts:1118` | 25 ms wait; rotation replay | The confirmation must precede reading the incumbent for a handoff. | Keyed creation/rotation replay yields before handoff side effects; direct sync API raises safe AccountMutationBusyError. |
| `rekeyOrchestratorSeatPaths` | `src/lib/orchestrator/seats.ts:1183` | 25 ms wait | The external path projection must commit before the migration marker closes. | Reentrant in startup migration; safe AccountMutationBusyError otherwise, leaving the migration marker unfinished for a fresh startup retry. |
| `mutateDeputies` | `src/lib/orchestrator/deputies.ts:275` | 25 ms foreign wait; async command/sweep queue | Deputy operations return the committed authority record; every replay would need fresh ownership checks. | Async command and sweep queue each store commit (2 s), rechecking the seat epoch on begin. Direct sync store API raises safe AccountMutationBusyError; no detached authority change. |
| `productionReportReplyPorts.withdraw` | `src/lib/telegram/bot/reportReplies.ts:67` | Async queue (2 s) | The returned withdrawal result must correspond to the still-held row fenced under the lease. | Async withdrawal queues (2 s) and rechecks row state/operation id under the lease before returning withdrawn. |
| `inRecordTransaction` | `src/lib/accounts/projectBindings.ts:293` | 25 ms wait | A binding mutation returns its committed record or BUSY; API paths already queue asynchronously. | The HTTP API queues asynchronously. MCP and the direct binding API return BUSY with the safe store sentence; callers retry after the holder finishes. The synchronous return reports no committed binding. |
| `ManagedCodexRuntime.record` | `src/lib/accounts/codexRuntime.ts:458` | 25 ms wait; existing queued replay | A short holder permits synchronous persistence; longer/local contention keeps the existing coalesced queue. | Existing coalesced async persistence queue replays latest records; client completion/cleanup continues while the holder remains runnable. |
| `withRegistryLock` | `src/lib/accounts/claude.ts:283` | 25 ms wait | Catalog operations synchronously return their committed account record. | Async manager admission and `/api/accounts/claude` provider edit/create and orphan cleanup queue each catalog commit (2 s); exhausted admission returns 503 `account_store_busy`. Provider model reads stay outside the lock. Direct catalog API raises safe AccountMutationBusyError without returning a committed account; retry after yielding. |
| `setActiveClaudeAccount` | `src/lib/accounts/claude.ts:325` | 25 ms wait | Selection must commit before its caller proceeds. | Async manager selection and compatibility routing queue. Direct sync API raises safe AccountMutationBusyError before selection changes. |
| `withRegistryLock` | `src/lib/accounts/codex.ts:297` | 25 ms wait | Catalog operations synchronously return their committed account record. | Async manager admission and `/api/accounts/codex` creation/orphan cleanup queue each catalog commit (2 s); exhausted admission returns 503 `account_store_busy`. Device login starts after the catalog lease releases. Direct catalog API raises safe AccountMutationBusyError without returning a committed account; retry after yielding. |
| `setActiveCodexAccount` | `src/lib/accounts/codex.ts:472` | 25 ms wait | Selection must commit before its caller proceeds. | Async manager selection and compatibility routing queue. Direct sync API raises safe AccountMutationBusyError before selection changes. |
| `setActiveCopilotAccount` | `src/lib/accounts/copilot.ts:173` | 25 ms wait | Selection must commit before its caller proceeds. | `/api/accounts/copilot` selection queues the commit (2 s); exhausted admission returns 503 `account_store_busy` with the safe sentence. Direct sync API raises safe AccountMutationBusyError before selection changes. |
| `createManagedCopilotAccount` | `src/lib/accounts/copilot.ts:184` | 25 ms wait | Creation must return the account that was durably added. | `/api/accounts/copilot` creation queues the commit (2 s); exhausted admission returns 503 `account_store_busy` with the safe sentence. Direct sync API raises safe AccountMutationBusyError without adding an account. |
| `ClaudeLoginSupervisor.persist` | `src/lib/accounts/claudeLogin.ts:340` | 25 ms wait; existing queued replay | A short holder commits the stdout transition before returning; longer/local contention keeps the existing queue. | Existing coalesced async persistence queue writes the latest stdout transition; login remains alive and the holder remains runnable. |
| `syncCompatibilityRouting` | `src/lib/accounts/migration/controller.ts:74` | Async queue (2 s) | The controller needs compatibility selection aligned with its authoritative routing snapshot. | Controller awaits async admission (2 s), then re-reads authoritative routing and commits compatibility selection reentrantly. No detached write. |

The browser seat classifier and the pipeline retry classifier share a pure
message predicate. Both recognize the safe public sentence, wrappers, and old
persisted lock wording. Lock-owner evidence remains in server diagnostics.
Admission revision exhaustion retains its own safe account_admission_changed
code and cause.

An explicit Claude pin is validated before fallback candidates, including its
post-refresh validation when expired. Pinned and automatic validation flights
keep their admission policies separate; the OAuth refresh fence still coalesces
the credential replacement. An explicitly pinned Claude candidate repeats its
live health probe at most three times when only the shared collection revision moves. Each probe retains its
600 ms network timeout and runs outside the lock; async snapshot/recheck admission
has a 2 s budget. A changed pinned catalog row or credential, including external
replacement during OAuth refresh, refuses admission with `account_admission_changed`, as does continuous revision churn after the
third probe. Automatic selection retains its existing retryable revision fence.

Focused regression evidence:

- All seven account-route catalog branches cover a local 8 ms holder, a foreign
  120 ms holder, a local contender behind a foreign holder and exhausted 2 s
  admission. The 21 local/foreign/timeout cases fail on the previous
  head with 400/500 and pass with queued success or the safe retryable 503.
- A pinned Claude probe with one unrelated refusal write admits 202 with one
  receipt; changed pinned catalog/credentials and continuous churn admit none.
- Local queued and locally held scenarios fail on the previous head and pass
  for the spawn refusal fence, Telegram withdrawal, compatibility routing,
  deputy command commits, deputy settlement and deputy note commits.
- The safe public sentence and its accepted-launch wrapper fail classification
  on the previous head and pass with the shared predicate; legacy strings stay
  covered by seatState.test.ts.
- Completed-seat replay arms the foreign release at the active-launch
  settlement dependency, after request preparation. The focused regression is
  red in 20 consecutive base runs, red on the updated head with waitMs: 0 at
  its acquisition, and green on the updated head.
- The original foreign-holder regressions remain in the focused caller,
  Codex runtime, Claude login and seat command test files. Runtime/login tests
  also cover their existing coalesced persistence during same-process holds.

All checks use exact file paths and isolated state/home/temp roots with a closed
Viewer control port. Hosted CI is not awaited.
