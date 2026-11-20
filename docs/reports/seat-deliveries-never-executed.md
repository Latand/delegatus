# Idle seat deliveries that never executed

Investigation date: 2026-11-14. Incident window: 16:17–17:30 UTC. Source revision: `fe4d96e4`. Related PR: #4029, head `3b68bed8`, still open when checked. This is a read-only diagnosis and implementation plan; no runtime intervention or regression test was performed.

The retained evidence establishes a delivery admission failure inside the Claude broker, followed by persistent refusal and queue starvation. It also establishes that seat monitoring noticed the outage but had no escalation for a live host whose incoming deliveries repeatedly failed. The strongest reconstruction of the initiating exception is exhaustion of the broker's three-input ledger capacity by an input retained across re-hosting and two new inputs. The original exception's specific class of failure was flattened before it reached the receipt, so that last attribution remains an inference. [E1–E6]

The five hand-overs do **not** establish five changes of turn identity. The broker uses `stale-turn` for several refusal predicates, including retained native uncertainty. No turn started during those hand-overs. PR #4029 would not recover the recorded idle state: its new watchdog requires an open turn, and its response recovery requires an already delivered wake. [E2, E3, E7]

## Evidence and read boundary

All times below are UTC. Private conversation, generation, project and operation identifiers were bound locally from the pinned task; they are intentionally absent here. The descriptions identify records by their kind and timestamp. `STATE` below means the installation's existing state directory, rather than the stage's sandbox state. No credentials were read or printed.

The deployed revision was confirmed in the retained deployment ledger: requested revision `fe4d96e4`, terminal success at **16:14:16.780**. The assigned checkout's HEAD is the same revision. The report uses that revision's line numbers unless a citation explicitly says PR head. [E1]

Database inspection used Python's standard SQLite client with an existing-file URI ending in `?mode=ro`, followed by `PRAGMA query_only=ON`; each connection was closed after reading. No application store constructors, migrations, refreshes or checkpoint commands were invoked. Files were opened for reading. The only repository write is this report. No send, host RPC, signal, restart, test suite, build, typecheck, staging or commit was issued.

Two nominal read tools were deliberately replaced with direct stored-record reads:

- `message_receipt` calls settlement and can end an overdue send: `src/lib/mcp/bindings.ts:2060`, `src/lib/runtime/sendSettlement.ts:923`.
- `lifecycle_events` refreshes its journal before querying: `src/lib/mcp/bindings.ts:7599`.

The broker does not retain raw provider stderr as a durable host log. It keeps a bounded in-memory tail for canonical terminal-exit matching (`src/lib/runtime/claudeStreamBrokerHost.ts:1072`). The inspected state-directory startup-output capture predates this incident, and neither current nor rotated `events.ndjson` contained the affected host's failure diagnostic. No missing access decision is needed to acknowledge those retention gaps. [E5]

### Evidence register

These are the commands and parameterized queries used. Placeholder values are the private bindings supplied by the pinned task. Output was examined in the audit conversation; raw private rows were not copied into repository artifacts.

| Ref | Read time on 2026-11-14 | Command/query and scope |
|---|---|---|
| E1 | 17:36–17:44 | `get_task` for the pinned task, whole details; `rtk proxy git rev-parse HEAD`; JSON read of `STATE/self-update/deployments.json`, selecting the deployed revision; registry queries below. |
| E2 | 17:38–17:42 | `rtk proxy python3 -` with read-only SQLite: `SELECT record_json FROM delivery_progress WHERE conversation_id=? ORDER BY updated_at`; select the incident window by `admittedAt`. Also `SELECT value_json FROM registry_rows WHERE collection='deliveryOperationOwners' AND row_key=?` for the named deliveries and predecessor inputs. |
| E3 | 17:38–17:42 | JSON-line reads of `STATE/structured-host-events/<generation>.jsonl` and `STATE/claude-delivery-ledger/<generation>.jsonl`, including the whole retained file and its final boundary. Read the registered Claude transcript and filter timestamps to `[2026-11-14T16:17:00Z, 2026-11-14T17:30:00Z]`, projecting record types, errors, last timestamp and usage only. |
| E4 | 17:39–17:41 | Read-only `state.sqlite`: `SELECT value_json FROM state_rows WHERE collection='lifecycle'`, then filter its decoded `value.conversationId` and the incident interval; the corresponding query for `collection='seat_tick_runs'`, filtering decoded project and time. Select settings and seat history from their existing collections. |
| E5 | 17:38–17:40 | Read-only runtime journal: `SELECT receipt_json,request_json FROM operations WHERE conversation_id=?`; `SELECT kind,state_json FROM entities WHERE id=?`; `SELECT MIN(seq),MAX(seq),MIN(occurred_at),MAX(occurred_at) FROM events`; scope-specific event reads. Read state-directory startup output and both retained `events.ndjson` files; inspect broker stderr handling in source. |
| E6 | 17:40–17:41 | Read the native ledger in code order. Track queued input UUIDs internally and remove only inputs covered by result, terminal, turn-boundary or no-write records. At native-ledger lines 86, 90 and 92, count unresolved capacity rows; compare with `recordNativeIntent` and replay code. This was a calculation over retained data, without invoking a host or test harness. |
| E7 | 17:37–17:44 | `rtk proxy gh pr view 4029 --json headRefOid,updatedAt,state,files`; `rtk proxy git merge-base fe4d96e4 3b68bed8`; `rtk proxy git diff fe4d96e4...3b68bed8 -- <changed-path>` and `git show` reads of new modules. Merge base is `fe4d96e4`; forge head matched the local object. |
| E8 | 17:41:09 | Read-only `SELECT record_json FROM delivery_progress WHERE updated_at>=?`, with the lower bound 2026-11-14 00:00 UTC in milliseconds. Keep admissions dated today, group by conversation and sort by `admittedAt`. Find runs of at least two failed receipts whose terminal reason is the settlement-window non-execution reason. Resolve each candidate's current generation and registry entry by primary key; compare its recorded process start identity with read-only `/proc/<pid>/stat`. Inspect the other candidate's retained turn boundaries. |

Earlier-answer searches used project-scoped `search_transcripts` queries for conversation-busy/stale-turn and seat silence, then an unscoped accepted-delivery query. The morning delivery audit was opened with `conversation_messages`: it accepted an earlier release and covered a window ending before this incident. A native-delivery review found by the same search covered consumed-echo persistence and reopening, without establishing this incident's cause. Memory searches for the same symptoms returned no incident-specific prior diagnosis; hit metadata was checked against the existing read-only memory index. Search tokenization discarded some generic terms, so empty or loose matches were not treated as proof of absence.

## Timeline

| Time | Retained observation |
|---|---|
| 16:12:12.953 | A pre-restart input was appended to the native ledger. Its consumed record established delivery, but no native result, terminal, turn-boundary or no-write record subsequently closed its capacity slot. It belongs to the previous writer. [E3, E6] |
| 16:17:11.473 | The previous host exited normally. Registry history records the replacement writer epoch. Restoration emitted an error end for the previously open turn; this did not write a native terminal boundary for its old input. [E1, E3] |
| 16:19:11.616–16:19:27.469 | The replacement host admitted and completed a new input successfully. Immediate total failure from re-hosting is refuted. [E3] |
| 16:19:53.963 | The final productive turn's native input was appended. [E3] |
| 16:19:57.499 | A finish notice was appended as a queued follower. Together with the pre-restart input, these made three ledger capacity rows without terminal boundaries. [E3, E6] |
| 16:20:19–16:20:22.820 | Another finish notice reached broker dispatch and failed with a native-intent persistence cause. There is no queued record for it in the native ledger. Its progress ends `uncertain`; its registry projection is failed with unverified disposition. The receipt does not distinguish ledger capacity from an I/O failure. [E2, E3] |
| 16:20:27–16:20:29 | The earlier queued follower's confirmation timer expired. This timeout was later superseded by positive delivery evidence. [E2] |
| 16:20:44.421 | The first undelivered seat wake was admitted. Its progress records **77 dispatch attempts**, repeatedly returning stale-turn before its settlement ending at 16:30:51.947. The retained phase history has dropped 108 earlier entries. [E2] |
| 16:20:52.033 | Last transcript record: a successful assistant answer. Provider input usage totals **766,205 tokens**. [E3] |
| 16:20:52.164–16:20:52.198 | Native result covers both final-turn inputs; both obtain operation-bound delivered records. Host emits completed turn-end, then idle. Its retained event ledger ends there. [E3] |
| 16:20:56.287 | Registry settlement confirms the last delivered finish notice. This is later than the engine boundary. [E2] |
| 16:21:30.449–16:31:34.584 | The diagnostic finish notice is accepted, waits behind earlier delivery work, makes five rejected hand-overs, then reaches its ten-minute settlement fence. Details below. [E2] |
| 16:37:21–17:19:58 | Tick reconciles failed own wakes as dropped and raises new ones. It records delivery alarms at 16, 24, 32, 39, 44, 49 and 53 minutes without delivery. [E4] |
| 17:20:21–17:29:47 | A newer seat wake makes 56 attempts, with retained stale-turn refusals through 17:29:47.511. Subsequent notices wait behind that wake. [E2] |
| 17:23:38.636 | The late diagnostic finish notice is admitted. It never makes a host-send attempt. Busy and lost-wake observations continue; 35 older timing marks have been dropped. [E2] |
| 17:26:31.432 | Tick records a 65-minute delivery alarm. It remains fenced by its outstanding wake. [E4] |
| 17:29:44.917 | Operator designates a replacement seat; activation follows at 17:29:47.725. [E4] |
| 17:29:59.722 | The late notice's progress ends because its recipient seat was replaced. This particular notice did not exhaust its ten-minute window. [E2] |

The lifecycle projection contains **25 expired and three delivered records** for the affected conversation in the broader incident interval. Its expired-event timestamp is `deliveredAt ?? assignedAt ?? createdAt`, so it frequently dates assignment rather than actual expiration (`src/lib/lifecycle/projector.ts:234`). The timeline above uses receipt settlement timestamps for endings.

For admissions from **16:21:30 through 17:23:38**, the progress store contains **20 deliveries: 19 failed and one uncertain**, with zero delivered. Including two later admissions before rotation gives **22: 21 failed, one uncertain**. Sixteen of those 22 have the proven non-execution settlement reason; five failed following seat replacement, and one remained unverified. Calling all of them proven never executed would overstate the records. [E2, E8]

### The five hand-overs

| Attempt | `host-send` mark | Awaiting-turn refusal | Elapsed |
|---|---|---|---|
| 1 | 16:30:57.484 | 16:30:57.603 | 119 ms |
| 2 | 16:31:03.830 | 16:31:03.915 | 85 ms |
| 3 | 16:31:11.379 | 16:31:11.459 | 80 ms |
| 4 | 16:31:22.866 | 16:31:23.016 | 150 ms |
| 5 | 16:31:32.656 | 16:31:32.822 | 166 ms |

The first attempt carried one message; subsequent attempts coalesced it with another queued message. These marks record calls to the host adapter. They establish neither a write to the provider nor a new turn. No corresponding native intent, turn-start, turn-end, provider error or transcript record exists. [E2, E3]

The adapter and queue do not persist the expected/observed turn pair or the actual refusal predicate. Therefore an exact pair for each attempt is **unknown**. Available health evidence is idle with a null active-turn reference; the code reconstruction below explains repeated rejection while that identity remains unchanged.

## Cause and cheapest refutations

### Confirmed mechanism and strongest initiating explanation

1. **An old writer's input occupied capacity after re-hosting — confirmed.** Native-ledger lines 85–86 retain its queued and consumed records. All later lines were inspected; none supplies its terminal boundary. Replay considers it delivered, while the capacity filter still counts it because that filter tests terminal proof rather than delivery. `src/lib/runtime/claudeNativeDelivery.ts:284`, `src/lib/runtime/claudeStreamBrokerHost.ts:214` and `:236`. [E3, E6]
2. **The next new input encountered a full ledger window — strongest inference.** After native-ledger line 92, one previous-writer input and two current-writer inputs satisfy the capacity predicate. `CLAUDE_NATIVE_INPUT_LIMIT` is three (`src/lib/runtime/claudeNativeDelivery.ts:105`). The next attempted intent fails at exactly this point in the recorded sequence. Capacity is checked before append, explaining the missing queued record. The generic persistence receipt alone cannot name the underlying exception. [E2, E3, E6]
3. **An intent failure leaves a blocking in-memory native state — confirmed code consequence.** `sendNative` inserts the delivery into `this.deliveries` before awaiting `recordNativeIntent` (`src/lib/runtime/claudeStreamBrokerHost.ts:1603`). The catch calls `noteNativeFailure` and throws at `:1605`; it neither removes that state nor gives it a no-write outcome. It has no outstanding-input owner, consumption proof or terminal proof. Even after the two real current inputs finish, `refreshNativeUncertainty` at `:1854` sees that stranded state; `nativeIdleSafe` at `:1849` refuses it. This explains a living idle host that rejects every following input. The state itself was in memory and is not independently retained as a snapshot. [E2, E3]
4. **The host reports its refusal as stale-turn — confirmed.** `sendNative`'s combined precondition at `:1565` includes native uncertainty as well as actual turn fences. The queue turns that reason into the awaiting-turn explanation at `src/lib/runtime/structuredDeliveryQueue.ts:2863`. The wording does not prove an identity changed. [E2]
5. **The executor starves later inputs behind the refusing leader — confirmed.** The undelivered wake ahead of the first diagnostic notice repeatedly retries until its ten-minute ending. Its end is followed about five seconds later by the diagnostic notice's first dispatch. The later wake keeps retrying while the late diagnostic notice remains at attempt zero. Per-conversation lanes and event-sequence ordering explain both waits (`src/lib/runtime/structuredDeliveryQueue.ts:1156`, `:1173`, `:2039`). [E2]

The initiating ledger-capacity explanation and the resulting retained-uncertainty explanation fit the full sequence without requiring another provider turn. A retained sanitized diagnostic identifying capacity, or a regression through the real ledger/host seam, would settle the remaining attribution to the initiating exception. A raw provider log is unnecessary for that distinction.

### Competing claims

| Claim | Status | Deciding record or remaining gap |
|---|---|---|
| The host was dead throughout the outage | **Refuted** | Replacement host completed two turns, retained host state is hosted/idle, and its recorded process identity still matched the kernel read at 17:41. [E1, E3, E5, E8] |
| An active model turn caused the nine-minute busy wait | **Refuted** | Final turn ended at 16:20:52.198 and host-event tail is idle. Earlier queue work was still retrying. `conversation-busy` is also an executor/admission condition. [E2, E3] |
| Five provider/context refusals started and immediately ended five turns | **Refuted within retained host evidence** | No new turn boundary or transcript record; no native intent for those attempts. Broker refusals happen before provider writes. [E2, E3] |
| The re-host left a stale active turn | **Refuted** | Restore ended the previous open turn and two replacement turns completed. [E3] |
| The re-host left a native delivery record that still counted toward admission | **Confirmed** | Old consumed input lacks a terminal ledger proof; reconstructed capacity reaches three before the failed intent. [E3, E6] |
| Context size directly rejected these sends | **Refuted for the demonstrated path** | Last provider answer succeeded at 766,205 input tokens; subsequent attempts stop at broker admission. The relevant capacity is a count of native inputs, independent of context tokens. [E2, E3, E6] |
| Context size affected automatic recovery | **Confirmed narrowly** | 766,205 / 1,000,000 is 76.6205%, below the configured 77% threshold. Context rotation therefore did not become eligible. `src/lib/monitor/seatAutoRotation.ts:119`. [E3, E4] |
| The initial native-intent exception was a filesystem failure | **Unknown, lower-ranked** | Receipt flattens all intent errors. Successful final-result ledger appends later that minute oppose a persistent storage outage; no retained errno diagnoses a transient failure. Capacity already explains the failure before append. [E2, E3, E5] |
| Lost wakes alone explain the outage | **Refuted as a complete cause** | Many host-send attempts occurred and were promptly refused. Late notices did suffer repeated overdue wakes, but also waited behind the refusing leader. Scheduling delay may amplify the outage; per-wake callback causes were not retained. [E2] |

## Accepted send to host-send at the deployed revision

| Step | Source | Durable effect or decision |
|---|---|---|
| Resolve recipient and recovery authority | `src/lib/delivery.ts:271`, `:330` | Resolve the durable conversation, enforce seat authority and route through `enqueueStructuredMessage`. A live host does not itself prove delivery readiness. |
| Reserve the message | `src/lib/runtime/structuredMessageDelivery.ts:1696`, `:1723`, `:1971` | `holdDeliveryOffLoop` retains the original key, content, command and target generation; owner/held-delivery rows survive the caller. |
| Claim and admit | `src/lib/runtime/structuredMessageDelivery.ts:2040`, `:2054`, `:2064`, `:2135` | Record checking progress, serialize conversation actuation, claim the attempt, then `client.command`. Admission contention can also record conversation-busy at `:2047` or `:2176`. |
| Commit runtime command | `src/lib/runtime/client.ts:265`; `src/runtime-host/host.ts:195`; `src/runtime-host/journal.ts:783`, `:853`, `:878` | Commit receipt event, operation entity, operations row and outbox effect together; notify consumers after commit. Acceptance precedes engine execution. |
| Select and serialize effects | `src/lib/runtime/structuredDeliveryController.ts:980`; `src/lib/runtime/structuredDeliveryQueue.ts:1148`, `:1173`, `:1334` | Read effects in event order, one lane per conversation. A later input can be busy because an earlier drain owns its lane; host health need not be active. |
| Read health and form attempt fence | `src/lib/runtime/structuredDeliveryQueue.ts:2304`, `:2476`, `:2492` | Read the adapter's health; build expected turn and, for native identity, an attempt-turn fence. Native uncertainty is absent from the broker's reported idle status (`src/lib/runtime/claudeStreamBrokerHost.ts:2118`). |
| Hand over, including coalesced messages | `src/lib/runtime/structuredDeliveryQueue.ts:1974`, `:1981` | Stamp host-send and call `host.send`. This timing mark is before the native intent and provider write. |
| Broker admission and native intent | `src/lib/runtime/claudeStreamBrokerHost.ts:1352`, `:1540`, `:1565`, `:1603`, `:1604` | Check current writer, uncertainty, pending work and turn fences. Insert in-memory delivery, then write native intent. The file ledger separately checks its three-input capacity at `:236`. |
| Provider write and turn start | `src/lib/runtime/claudeStreamBrokerHost.ts:1636`, `:1646`, `:1651` | Only after the native intent succeeds: register outstanding input, write stdin and emit turn-started if idle. Neither failed diagnostic delivery reached this point. |
| Refusal reduction | `src/lib/runtime/structuredDeliveryQueue.ts:2793`, `:2863` | Typed stale-turn and rejected stale-turn both return to queued/awaiting-turn. The rejected-receipt branch stops the current drain; the earlier effect continues to order later work. |
| Receipt and progress retention | `src/lib/runtime/structuredDeliveryController.ts:954`; `src/lib/runtime/deliveryProgress.ts:50`, `:126` | Record phases, attempts, timing and endings in `delivery-progress.sqlite`; bounded history can drop old entries. Registry owner projection survives runtime-operation compaction. |
| Settlement | `src/lib/runtime/sendSettlement.ts:146`, `:702`, `:768`, `:1169`, `:1215`, `:558` | Ordinary window is ten minutes; running-turn routing has separate bounds. Re-read journal and recipient evidence, then fence still-queued work before claiming proven non-execution. Uncertain work retains its ambiguity. |

The native ledger, memory-hook queue and host-event ledger are separate writes. Optional memory-hook append failures are swallowed because missing hook evidence must abstain (`src/lib/runtime/claudeStreamBrokerHost.ts:1586`, `:1659`). Native-intent failure is propagated and logged as a fixed error class, phase, allowlisted cause class and errno (`:1490`); host-event append failure enters the host failure path (`:2309`). The incident receipt retained the native component and phase, while losing the specific capacity-versus-I/O reason. All affected sends have durable admissions, so an upstream request that never reached ingress is outside this incident's explanation.

## What the seat tick knew

The claim that the tick did nothing is too broad. Its retained run records show repeated reconciliation, delivery alarms and new wake admissions. It correctly withheld credit for undelivered work. Its recovery coverage was insufficient. [E4]

- `reconcileOutstandingWake` reads the current wake's destination receipt (`src/lib/monitor/seatTickController.ts:1137`). A proven dropped wake clears that attempt at `:1187`; the next check can derive another wake. There is no cumulative failed-incoming-delivery recovery transition here.
- The existing delivery watchdog preserves the first unsatisfied decision and raises its alarm after 15 minutes (`src/lib/monitor/seatTickWatchdog.ts:3`, `:22`). Its output is a diagnostic and wake payload; it does not turn a live host into a re-host candidate.
- The recovery admission helper probes conclusive host loss when required or MCP is dead (`src/lib/monitor/seatTickController.ts:1809`, `:1829`). A healthy MCP and live idle process pass ordinary wake admission without repairing the broker's poisoned native state.
- `signals` calls `sendFailureSignals` with the seat conversation (`src/lib/monitor/seatTickSources.ts:1591`). That function selects **sender or fallback-recipient** notices, not failures targeting the seat (`src/lib/runtime/sendFailureNotice.ts:125`). It is not an incoming-failure streak.
- Delivery lifecycle events carry no project (`src/lib/lifecycle/projector.ts:224`), while the tick pages a project journal (`src/lib/monitor/seatTickSources.ts:1852`). They are not a substitute for a recipient-indexed seat health summary.
- Context auto-rotation checks its independent threshold and safe point (`src/lib/monitor/seatAutoRotation.ts:119`, `:129`). Here the threshold was not reached; outstanding wake ownership was another relevant fence.

Thus the monitor repeatedly sent recovery work through the same refusing delivery seam. The board alarm did not have a bounded escalation into the existing host recovery/rotation mechanisms for this state.

## Coverage left by PR #4029

The forge head was `3b68bed8` in both observations. Its merge base is the deployed revision. The diff adds turn-silence handling in all three engine adapters, persisted delivered-wake response tracking, recovery nudges and reuse of lost-seat rotation. It also bounds quota-control history reads and protects ownership around resumed tools, operator controls and provider waits. These features should be reused. [E7]

| PR-head path | Why it does not resolve this recorded incident |
|---|---|
| `src/lib/runtime/turnSilence.ts:64`, `:91`, `:151`, `:175` | Arms from turn-start, stops on turn-end and requires the same active turn at expiry. The last real turn completed; idle native-admission poison has no open turn for this watchdog. |
| `src/lib/monitor/seatTick.ts:2281`; `src/lib/monitor/seatTickController.ts:2025` | Creates/reads `wakeResponse` after a wake lands. The failing wakes never landed. Any older successfully answered wake is not evidence that a later undelivered one owes a response. |
| `src/lib/monitor/seatTickController.ts:2082`, `:2095`, `:2115` | Bounds response recovery and emits a durable nudge for a delivered unanswered wake. It adds no recipient failure-streak observation and no repair for native admission. |
| `src/lib/monitor/seatTickController.ts:1893`, `:2108` | Replacement still requires conclusive host loss. The affected process remained alive. |
| `src/lib/runtime/claudeStreamBrokerHost.ts` diff | Adds silence observation and termination, without changing native capacity, failed-intent insertion, uncertainty recovery or stale-turn reason selection. |

**Counterfactual: no recovery is established for this seat at that head.** Its two entry conditions are absent from the recorded failure. The uncovered outcome is delivery to an idle living host, plus bounded recovery after repeated incoming failures even when no input reached the provider. This lane needs those changes and their regressions; a regression-only delivery is insufficient.

## Other conversations today

At **17:41:09**, the bounded scan covered **847 retained admissions today across 416 conversations**. Two conversations had a run of at least two settlement-window non-execution failures. Only the affected seat had a matching live structured process, idle registry status and null active-turn reference. It had a maximum strict run of twelve such failures; an uncertain receipt breaks a strict run even though it represents no confirmed recovery. [E8]

The other candidate had two failures and no current live host. Its retained host events show a turn running from 00:10:09.759 until 00:26:54.998, covering the admissions at 00:12 and 00:15. It does not establish another idle-host incident. The earlier morning audit independently observed those deliveries during active work.

**Bounded result: zero other currently alive/idle matches.** This is not an exhaustive historical liveness reconstruction: today's delivery receipts are retained, while every conversation's prior kernel state and every refusal predicate are not.

## Concrete build and regression plan

1. **Write the real-seam reproduction first.** Extend `src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts`. Use the real `FileClaudeDeliveryLedger`, broker start/adopt path and controlled CLI transport. Persist an old writer's consumed input without its terminal boundary, end that owned writer, adopt a replacement, and complete one replacement turn. Start a second replacement turn, admit its follower, then attempt a third new input while both are outstanding. Require either legitimate bounded admission or a typed refusal explaining ledger capacity. Complete the two real inputs and send another message from idle. On deployed main the third intent exhausts the ledger window and leaves the next idle send rejected through native uncertainty. Assert provider write count, receipt state, idle health and native records, including no duplicate of the previous-writer input. Demonstrate base failure before selecting the repair.
2. **Repair capacity and failed-intent ownership separately.** Reconcile capacity against the current, verified writer lineage; preserve previous consumption/unknown outcomes and never infer provider success from host exit. A previous-writer row must not consume a current-writer admission slot indefinitely. For a proven pre-append rejection, do not leave a possibly written native state in memory. For an append/fsync with uncertain outcome, retain the write fence and surface its cause. A blanket removal after any persistence exception would violate delivery safety.
3. **Preserve the refusing predicate.** Add bounded structured refusal evidence to the host receipt: component, stage and allowlisted reason such as capacity exhausted, native evidence uncertain, pending terminal persistence or actual turn-fence mismatch. Distinguish expected/observed nullness and a changed identity without publishing provider bytes or caught exception text. Keep the original operation/key and carry the reason into progress and final settlement.
4. **Extend existing seat recovery observation.** In the current seat accounting row, retain a small incoming-failure summary scoped to conversation and seat epoch: first failure time, last settlement cursor, bounded count, latest cause and last positive delivery. Feed it from terminal delivery changes or a recipient-indexed bounded page. Include operator and finish-notice deliveries as well as tick wakes. An uncertain outcome remains verify-first; counting it as unhealthy must never authorize replay.
5. **Escalate through existing owners.** Reuse the existing 15-minute delivery alarm as the proposed escalation bound, independent of the 30-minute ordinary wake interval. After at least two consecutive terminal incoming failures and no later delivery for that bound, re-read host/turn/permission/tool/background/retry state and all operator/epoch fences. Reuse the current durable nudge attempt, existing fenced host cleanup/re-host mechanism, then the existing rotation fallback if confirmed cleanup and revival cannot restore delivery. Expose stage, bound, cause and ownership hold on the existing recovery card. Persist escalation so restarts or fresh failed wake keys cannot reset its clock. Coordinate these entry conditions with #4029's `wakeResponse` and `hostRecovery`; use one recovery owner and its existing idempotency keys.
6. **Add the seat regression.** Extend `src/lib/monitor/seatTickController.delivery.test.ts` using the real delivery seam from step 1. Keep host alive and idle, make successive own wakes and an agent notice expire, cross the bound, and assert the existing recovery mechanism fires once with the failure cause on the card. Repeat across controller restart and seat replacement. A successful delivered/answered input resets the failure episode; queue kicks and newly prepared failed wakes do not. Verify a legitimately active turn with model/tool progress, foreground or background ownership, permission, provider retry, unknown evidence, or explicit operator stop never gets displaced by this rule. Cover failed re-host followed by existing rotation, plus uncertain deliveries remaining protected from duplicate sends.
7. **Keep work bounded.** Consume only recipient-indexed terminal changes, with a fixed page limit and persisted watermark; update constant-size seat state. Do not scan global operation/progress/stop history on every tick. Test with a large unrelated history and assert bounded rows read, including behind a continuously advancing journal. Recovery waits must be asynchronous, deadline-bounded and labelled with their owner. No performance gain is claimed by this diagnosis.
8. **Validate the implementation separately.** Run only touched test files by explicit path with one owned lifecycle runner per file, separate isolated state, HOME and TMPDIR, and a closed Viewer control URL. The build lane owes its named TypeScript, lint, merge-base privacy and committed-tree pre-push touched-test checks. This diagnosis ran none of those suites and changes no implementation. Runtime-risk review remains three rounds.

## Remaining evidence gaps and minimum instrumentation

The durable records establish the stale capacity row, the native-intent failure, the idle/refusal mechanism, queue starvation and absent escalation. They do not preserve the exact initial exception, the in-memory delivery set after that exception, or the actual rejecting predicate at each later hand-over. Runtime event retention had already compacted the earliest receipt events: at the 17:38 observation its 20,000-event window began at 16:41:01.497. Registry owners, native ledger and progress retain complementary earlier evidence; some progress histories are themselves truncated. [E2, E3, E5]

The smallest next-incident instrumentation is one bounded diagnostic record on native-intent failure and one on a change of refusal predicate: component, allowlisted reason/errno, writer epoch, current-writer versus previous-writer capacity counts, outstanding count, uncertainty source, and expected/observed turn relation. Keep private correlation in the installation's existing operation receipt/progress record, with public projections exposing kinds and counts. Include the earlier blocking operation's kind and phase in conversation-busy progress. Coalesce repeats while preserving first/last time and count. That would distinguish ledger exhaustion, I/O uncertainty and a real turn race without retaining raw provider stderr or adding a global scan.

No additional production access or operator action is required for this stage. The unrecorded in-memory facts cannot be recovered by another safe file read. The proposed real-seam regression is the next step for proving the initiating capacity inference and choosing the repair.

Report validation: `rtk proxy bun scripts/privacy-publication-gate.ts --require-known-values --base fe4d96e4 --paths docs/reports/seat-deliveries-never-executed.md` passed. Manual review found no private identifiers, account names, hostnames, absolute home paths or private quotes. Repository status showed only this declared report as an untracked addition. No implementation checks were run.
