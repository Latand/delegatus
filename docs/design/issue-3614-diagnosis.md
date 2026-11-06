# Nested registry reads during wake reservation

> “Resuming an idle row with a proven-dead writer and engine plus retained scope can reserve the original automatic wake in that same check on SQLite.”
>
> Originating public requirement, 3 November 2026: [issue #3614](https://github.com/Latand/delegatus/issues/3614).

The 6 November dispatch instruction requests investigation of recent issues and their later comments. Its private wording is excluded from this public document. The full issue body and complete comments endpoint were read; the issue remains open, has zero comments, and was last updated at `2026-11-03T16:21:28Z`. The exact approved input is D1 and its matrix/overlap rows in `b8c5744b80cfdd21012b932372a844e76d8ed6f8:docs/audits/recent-issue-dispatch-followthrough-2026-11-06.md`. The originating report's final turn was also opened.

## Decision and immediate implementation steps

The defect is reproduced on the assigned main revision `423bf964ed98d9dde744ad0f2c4f2dbf92ae146b`. A resumed seat reaches delivery reservation, whose recovery guard makes a keyed registry read inside an open SQLite mutation. The reader mistakes consumed writer admission for absence of a transaction and executes another `BEGIN`.

Implement a local transaction-ownership correction in `SqliteAgentRegistryStore.read`, then add regressions in the two existing test files listed below. Determine whether the reader owns a transaction from `this.db.inTransaction`, using the existing pattern in `conversationAuthorityFacts`. Only the call that opened a transaction may commit or roll it back. A nested synchronous read borrows its caller's connection and transaction. Keep `writerHeld` and its admission/consumption lifecycle unchanged.

This stage supplies diagnosis and an implementation contract. No product source was edited, no fix was tested, and no deployment or installed acceptance is implied. A diagnostic wrapper temporarily changed the reader's view of admission only while calling the original reader; that wrapper is evidence for transaction borrowing and must never be shipped as the repair.

## Current call chain and confirmed cause

The issue's historical `reserveDelivery` name no longer exists at this revision. The current path is:

1. `runSeatTickCheck` prepares an automatic wake and its original key.
2. `deliverConversationMessage` (`src/lib/delivery.ts:862`) invokes real structured recovery and forwards the returned admission guard at line 881.
3. `recoverDeadStructuredConversation` creates a successor through the existing spawn seam. Its guard (`structuredRecovery.ts:646`) calls `assertAuthority` (line 548), including `runtimeSwitchRetirementReason`, then checks the resumed receipt, owner and claim epoch.
4. `enqueueStructuredMessage` calls `AgentRegistry.holdDeliveryOffLoop` (`structuredMessageDelivery.ts:1747`). Writer admission and the account lease precede `holdDelivery`.
5. `holdDelivery` calls its guard inside the mutation (`registry.ts:10954`), before inserting a fresh reservation. The guard reads `conversationMemberships` (line 7413), through `readKeyed` (line 5886), into `SqliteAgentRegistryStore.read` (line 3733).
6. `mutate` captured and cleared `writerHeld` at `sqliteRegistryStore.ts:4322–4323` while keeping its transaction open. `read` currently checks that flag, then executes `BEGIN`. The observed boundary has `writerHeld=false`, `db.inTransaction=true`; SQLite raises `cannot start a transaction within a transaction`.

The outer mutation rolls back and releases admission. The resumed host remains available. In the fixture, the following automatic check reserves the same key and the queue writes it once. This is the extra-check latency described in the primary issue.

The snapshot locations named in D1 were inspected: `snapshot` at 1606, `loadSnapshot` at 1654, `readOnlySnapshot` at 1691, and refresh ownership at 2395. The actual failing membership lookup takes the keyed reader. Preparing the snapshot in advance does not repair it. Whole-snapshot routing, preparation and cache policy are outside the proposed patch.

Three competing explanations were distinguished:

| Hypothesis | Discriminating observation |
| --- | --- |
| Missing transaction ownership in the nested reader | Reproduced with the real retirement guard; borrowing the already-open transaction lets the first wake reserve. |
| A prepared reader or stale full-snapshot cache alone causes the failure | Both cold and prepared SQLite fixtures fail with the same keyed-read exception; JSON controls reserve successfully. |
| External writer contention or failed host recovery causes the first refusal | The uncontended fixture resumes exactly one successor before failing. Independent contention produces a bounded refusal, while the event loop continues. |

## Isolated evidence

All probes used a `git archive` export of the assigned revision under the stage's scratch root, installed dependencies, Bun `1.4.0 (34cbb9a40)`, and the designated gate wrapper. Each invocation selected one explicit test file with `bun run test`, fresh HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR, a closed Viewer control endpoint, and local gate execution. No recorder, custody handoff, live message, model request or production state was used. Fixture-generated identities and raw logs stay outside the public repository.

Private retained evidence is under `$LLV_EVIDENCE_DIR/diagnosis/`. Final probe sources, invocation metadata and source hashes are retained there. The two scratch test paths are `src/lib/agent/nestedRead.probe.test.ts` and `src/lib/monitor/nestedWake.probe.test.ts`; these are diagnostic artifacts, not proposed repository additions.

| Final observation | Result and exact limit |
| --- | --- |
| `probe7.log`, agent probe, actual exit 0 | 6 cases, 29 assertions. JSON cold/prepared controls succeed. SQLite cold/prepared controls reproduce the exception. These assertions expect the defect; their green result does not mean the product is repaired. |
| `probe5.log`, ticker probe, actual exit 0 | 5 cases, 44 assertions. Real ticker, delivery, recovery, registry reservation, runtime journal and queue; existing fixture builders provide the seat and child outcome. Spawn is a fixture using real claim/stage/finalize APIs. The engine boundary uses `FakeEngineHost`. |
| Unmodified ticker path | One successor, first reservation fails, wake timestamp unchanged; next automatic check retains the key. Two queue drains produce one engine-ledger write and a delivered journal receipt. |
| Borrowing diagnostic control | One successor, first check queues its wake; two drains produce one write and a delivered receipt. There is no early wake timestamp credit. |
| Final-await authority changes in borrowing control | Replacing the claim owner or incrementing the writer claim epoch returns `structured-recovery-superseded`/409. Changing seat epoch returns `seat-rotated`/409. Each reserves zero deliveries. |
| Nested read-only transaction across a peer commit | Outer and nested readers both observe one conversation; after their transaction closes, a fresh read observes the peer's second conversation. |
| Physically read-only connection | Baseline nested read fails. Borrowing control reads successfully; a caught inner exception leaves the outer transaction open, and outer completion closes it. A write remains refused. |
| Writer deadline and FIFO cleanup | Two concurrent admissions against an independently locked connection both refuse at approximately 82 ms with an 80 ms configured bound and 14 timer callbacks. After release, the next reservation succeeds. No throughput or production latency gain is claimed. |
| Durable reopen | Reopening the registry and replaying that successful reservation returns the same delivery identity and leaves exactly one reservation. This establishes registry reopen behavior, not whole-process crash recovery. |

Earlier probe logs remain as diagnostic history. `probe2` exposed harness mistakes: the JSON ticker's lineage reader refused before delivery, and the resume fixture omitted setup columns cleared by dead-host reconciliation. `probe4` included an invalid owner-change accessor; its apparent passing owner case is discarded. The corrected final cases assert exact refusal reasons. JSON comparison is established at the reservation boundary; no successful full JSON ticker run is claimed.

The engine is a protocol fixture. A delivered journal receipt and one fake-engine ledger write do not prove an actual provider turn or destination transcript. Original incident harness bytes were not recovered; the current failure was independently reproduced. Runtime-switch retirement, conversation-generation replacement, killed-process restart, and final implementation behavior remain explicit builder acceptance work below.

## Exact files and keep-list

| File | Authorized implementation hunk |
| --- | --- |
| `src/lib/agent/sqliteRegistryStore.ts` | `read<T>` at 3733–3747 only: capture transaction ownership from the connection; condition BEGIN, COMMIT and ROLLBACK on that captured ownership. Preserve cold-key initialization, lazy normalization and error propagation. Model this on the same file's `conversationAuthorityFacts` at 4057. |
| `src/lib/agent/sqliteRegistryStore.readOnlyView.test.ts` | Add nested keyed-read cases over writer, ordinary read and physically read-only connections; snapshot consistency, exceptions, bounds and reopen behavior. Use existing registry/store fixtures and the existing lock-holder fixture for process contention. |
| `src/lib/monitor/seatTickController.idleDelivery.test.ts` | Add the recovered-idle-seat case beside the existing queue-drain case. Use `childFixture`, `childRig`, `hostedSeat`, the real recovery entry point and real queue/journal. Add only local fixture setup. |

Keep unchanged: `registry.ts`, `structuredRecovery.ts`, `structuredMessageDelivery.ts`, `runtimeSwitchFence.ts`, ticker production files, shared ticker fixture, all runtime-host source, schema/indexes, `withWriter`, `tryWriter`, mutation batches/savepoints, optimistic mutation retry rules, prepared-reader selection, snapshot caches, grant normalization and state ownership. Keep all original uncertain operations, delivery identities, account authority and review budgets. Do not transplant the diagnostic `writerHeld` wrapper. If an additional production hunk is needed, reproduce that requirement and recheck its owner before expanding the contract.

No new framework or ADR is needed. The existing native connection property already represents the needed fact. Removing the guard, catching the SQLite exception as success, pre-reading membership before admission, adding a ticker retry, and widening synchronous registry scans would lose required guarantees or leave the demonstrated cause intact.

## Producers, consumers and invariants

`withWriter` and `tryWriter` acquire writer admission; `mutate` consumes it and owns its commit/rollback; `withMutationBatch` retains writer admission across its savepoints. Direct optimistic mutations also execute their callback inside a read transaction. `read` must borrow either kind of active transaction, without claiming a write lock or ending its parent's transaction. Standalone reads still open and close their own transaction.

The shared consumer is `AgentRegistry.readKeyed`, including membership, recovery-fact and reservation lookups. Recovery constructs the guard; delivery forwards it; structured enqueue runs it at the reservation mutation; the queue and settlement readers consume the persisted reservation. No callback signature, schema, default, copied guard or persisted format changes. Reads in a mutation observe the SQLite transaction's persisted pre-transition state; this patch does not promise visibility of arbitrary unpersisted JavaScript draft edits. The reservation guard runs before its reservation changes.

The connection wrapper in `state/currentDatabase.ts` already uses `inTransaction` and retains database-swap fencing. Borrowed reads must propagate its errors. A borrowed read must never swallow an exception, commit a parent's transaction, or roll back a parent's transaction that the caller intends to handle. The outer mutation remains responsible for rollback when its guard escapes.

## Builder acceptance and checks

The final tests must run without diagnostic monkeypatches. First add the behavior assertions and show the first-wake and nested-read cases fail on the base, then apply the one reader hunk and show them pass.

1. An idle seat with proven-dead writer/engine evidence recovers once, reserves its original wake on the first check, and reaches one queue delivery. Replay the same request key and count one destination input/turn in an isolated engine fixture transcript as well as one journal operation. No timestamp credit before delivery confirmation.
2. Exercise cold/prepared stores, synchronous mutation, async admitted mutation, nested read inside read, and a physically read-only connection. Use a second connection committing between outer and inner reads to prove a single read revision. Exceptions preserve parent transaction ownership; outer success/failure leaves the next admitted writer usable. Verify writer flags after each exit. Preserve mutation-batch savepoint behavior.
3. At the last asynchronous preflight before reservation, change claim owner, writer epoch, conversation generation, seat epoch and runtime-switch retirement separately. Each applicable guard returns its existing precise refusal and writes no reservation. Remove the final authority check in a scratch negative control and show that the corresponding race test fails.
4. Hold the writer from the existing separate-process lock fixture. Verify the configured total admission deadline, timer progress, no reservation on expiry and subsequent FIFO progress. Record both successful and refused observations, including cases without a final delivery record. Keep production's existing bound; introduce no retry clock.
5. Reopen registry and journal after failure, after reservation and after simulated effect-with-lost-reply. Reconcile the original key and authority without choosing a different target. A possibly delivered result remains uncertain until evidence resolves it; neither restart nor the fix may authorize duplicate input or early wake credit. Include the fixture's restart/process boundary, not only object reopen.
6. Compare the original first-wake example with the final result and retain measured conditions. The patch claims removal of the demonstrated extra-check failure, without a general performance claim. Preserve combined #3710 recovery lookup semantics and all neighboring owner changes.

Run these full explicit files, one command at a time through the designated wrapper, with fresh isolation and logs:

| Check | Why |
| --- | --- |
| `bun run test src/lib/agent/sqliteRegistryStore.readOnlyView.test.ts` | New ownership, snapshot, read-only and rollback cases. |
| `bun run test src/lib/agent/sqliteRegistryStore.keyedWrites.test.ts` | Existing lazy mutation and keyed-write contract. |
| `bun run test src/lib/monitor/seatTickController.idleDelivery.test.ts` | First-check recovered wake, queue identity and confirmation. |
| `bun run test src/lib/runtime/structuredMessageDelivery.sqlite.test.ts` | Existing SQLite delivery admission. |
| `bun run test src/lib/runtime/structuredRecovery.test.ts` | Existing recovery/authority behavior; rerun against combined owner source when integrated. |

Use required pre-commit/publication hooks and hosted CI at their normal later boundary. The builder runs no broad runtime directory suite, build or standalone typecheck under this brief. Retain the prescribed three review rounds for this durable-delivery/security-sensitive change; review the exact final source and concurrent diffs. A merged source commit never establishes installation or full production acceptance. This lane retains `finishesTask: false`.

## Concurrent work and conflicts

Current main and assigned HEAD both resolve to `423bf964` on the final source recheck. The full open PR file inventory and both pages of open lanes were inspected. Relevant actual diffs were read:

| Owner/change | Observed overlap and disposition |
| --- | --- |
| #3710, owner `8d3b0380`, lane `83306a33`, `edb2bf06` | Local and published heads agree; local checkout is clean. Adds recovery lookup helpers near old `registry.ts:6216` and `sqliteRegistryStore.ts:1086`, plus an import. No change to `read` or `mutate`. Preserve the original uncertain admission and fixed review budget. Shared read behavior needs combined acceptance. |
| #3677 diagnosis, lane `78a6b1e8` | Same starting source, clean observed checkout, no product diff. Owns recovery/queued-work diagnosis. Keep its host and delivery repair separate; this reader contract can supply its lower-level prerequisite if its own evidence requires it. |
| #3692, lane `ad3305c6`, `5e4e02a8` | Local checkout clean. Actual ticker changes concern journal flushing, timing and curation sweep coordination. No proposed reader/test hunk overlaps; preserve its existing exhausted-budget outcome. |
| Historical #2926, `9ba35560` | Actual SQLite diff adds signal-domain preservation triggers; registry changes protect host/namespace lifecycle. No reader-ownership hunk. An open historical PR does not reserve the whole registry. Preserve its lifecycle checks if integrated. |
| Closed lane `665a9861`, `ac965a07` | Read-only inventory found staged deletions plus untracked copies of the relevant files. Each inspected copy is byte-identical to that checkout's own HEAD. These retained user bytes were left untouched and are not adopted as a fix. |

A scan of registered extant worktrees found no other uncommitted changes to the proposed source, shared registry/recovery path or selected ticker fixture/test. Missing historical checkouts remain unknown. This is an observation at inspection time; the builder must repeat the exact-hunk comparison before editing and before review. No board, owner or publication state was changed for coordination.

## Deferred — not currently justified

Whole-snapshot transaction/routing changes, a global synchronous-read audit, new registry abstractions, schema/index changes, additional retry machinery, host lifecycle repair, broad ticker optimization, account/settings changes and live replay are deferred. Separate #3677/#3689 work remains with its owners. Production or installation acceptance requires its own authorized evidence. The original unknown operations are neither retried nor adopted by this diagnosis.

## Diagnosis-stage verification

The final diagnostic evidence is `probe5` and `probe7`, both actual exit 0, with the limitations above. Only this document is an intended worktree output. The repository privacy scanner passed with required committed fingerprints and this document explicitly selected through `--paths`; actual exit 0. The whitespace check passed, and worktree status showed only this new document. Receipts remain with the private evidence. No product suite result, source repair, native provider execution or deployed behavior is claimed.
