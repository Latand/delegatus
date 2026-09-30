# A message to an agent arrives, or fails with its reason

Status: design, 2026-09-30. Merge base and current main: `ce8abf18b`, which
production was also running when this was written.

## Originating requirement

Operator, 2026-09-29, on the board: "давай далі що в нас є" (continue with the
work already on the board). The lane took the Inbox task **"Сообщение агенту
доходит или честно падает с причиной"** (a message to an agent arrives, or
fails honestly with its reason). The pinned outcome:

> a message to a finished or idle agent is either delivered exactly once within
> a bounded wait, or ends in a clear failure that names the reason. Nothing
> stays in "synchronizing", "starting", in-flight or outcome_unknown forever,
> and a send never fails the first time only to succeed on an identical resend
> seconds later.

Acceptance, abridged: re-verify #2020, #2028, #2046, #2058, #2002, #1866 and
#1974 on current main. For each one that is still real, a resume that cannot
claim a process in bounded time settles as failed with its reason, a send that
has to resume a host waits for that resume and delivers once, recovery lookups
never answer unknown forever, and the #2002 receipt ordering settles. Add one
regression test per fixed issue, red on the merge base and green on the head,
driven through the production code paths. Keep out of the transient
network/git retry work in pipeline provisioning and deploy.

## Verdict

Six of the seven items are still real on current main. One (#2002) is already
fixed. The still-real ones share three defects, and one plan fixes all three:

1. **A host-publication marker has no end.** A row with
   `pendingAction: "spawn"` means "a host is publishing ownership". The
   delivery layer waits on that marker or refuses because of it. Two writers
   leave the marker in place with nothing left to clear it: the headless flow
   reviewer, and a resume that parked in staged recovery.
2. **A resume is not awaited, and a failure before dispatch is reported as
   uncertain.** The send that started a resume dispatches (or gives up) before
   the resumed host is published. A failure that happened before anything
   reached the runtime is recorded as `delivery-uncertain`, which the
   settlement rules treat as possibly executed.
3. **Two answers that no later read can change.** A Viewer refusal made before
   any reservation existed stays `outcome_unknown` for every later lookup. An
   accepted send that is past its settlement deadline is only settled by
   `message_receipt`, never by the `send_message` lookup under the original
   key.

## How this was verified

- **Code** on `ce8abf18b`. The file:line references below are at that commit.
- **Tests run by path** under Bun 1.4.0, in a `git archive` export of HEAD
  with its own `LLV_STATE_DIR` (no live-state sweep).
- **Read-only queries** of the live registry (`agent-registry.sqlite`, opened
  `readonly`) and one read-only MCP call (`conversation_deliverability`). No
  message was sent and nothing was written.
- **`search_transcripts`**, project-scoped and then unscoped: `#2020`,
  `#2028`, `#2046`, `#2058 OR #2002 OR #1866 OR #1974`, `72077f73`,
  `"runtime host request timed out" handoff launch`,
  `composerSubmissionPayloads revision terminal receipt`,
  `trigger migration failure-atomic marker sqliteRegistryStore`,
  `reclaimed in-flight resume never delivered 64 minutes`. The hits used:
  - The 2026-09-25 backlog triage (conversation `f3a5f450…`). It filed #2020,
    #2028 and #2046 as one task `72077f73` ("some messages never settle or
    fail on the first try") and did not re-verify them.
  - The orchestrator seat conversations that filed #2020, #2028 and #2046
    (session files `d873f851…`, `999bc9e0…`). They record the observed
    symptoms and nothing about causes.
  - The #1967 review (Codex sessions of 2026-09-21, `01a0c139…`,
    `01a0c13a…`). It is the source of #1974, and its line numbers predate
    #1971.
  - The #2051 fix review (conversation `be74846d…`, 2026-09-23). It names the
    #2058 spawn as "separate and not addressed there".

  None of the earlier work fixed or explained the defects below.

## Re-verification

| Issue | Classification | Evidence |
|---|---|---|
| #2002 composer payload never settles on a revision-1 terminal receipt | **fixed** | `d992539b7` (#2293, 2026-09-28). `composerSubmissionPayloads.ts:362-368` keeps the admitted operation's own arrival or discard below a higher journal revision, and `payloadAttemptState` (`:92-99`) prefers it. `composerSubmissionPayloads.dom.test.ts`: 4/4 pass on HEAD. With the file restored from `d992539b7^`, 3/4 fail ("the admitted operation's delivered outcome settles the payload past a higher open journal revision", its discard twin, and the lower-revision-after-outcome case). The issue can be closed with that commit. |
| #1974 part 1: registry trigger migration not failure-atomic | **still real** | `sqliteRegistryStore.ts:541-563` still runs the trigger replacement as one multi-statement `db.exec` inside `transaction().immediate()`. Reproduced under Bun 1.4.0 with a runtime fault (`RAISE(ABORT)`) on the marker write: no exception, the new trigger is committed, the marker stays `1`. A runtime fault in a middle statement is also swallowed, and the statements after it still run. Only prepare-time errors throw and roll back. The same pattern is at `:506-517` and `:565-569`. The damage is bounded (the next open re-runs the idempotent `DROP IF EXISTS`/`CREATE`), but the migration is not atomic, as the issue says. |
| #1974 part 2: pre-dispatch readiness failure strands the message as uncertain | **still real** | `structuredMessageDelivery.ts:745`, `:757`, `:759`, `:769` and `:771` return `"delivery-uncertain"` before `client.command` is ever reached. `git blame` dates them to 2026-07-18, 07-22 and 08-31, so nothing has changed since the review. `coordinator.ts:1092-1095` records that verdict on the reservation. |
| #2020 message to a finished flow reviewer: `starting`, no process, `outcome_unknown` forever | **still real** | See [#2020](#2020-the-headless-reviewer-row-never-leaves-starting). Reproduced on current main: `conversation_deliverability` for the #2028 lane's own review-loop reviewer (`conversation_5a6a113e…`, round ended 2026-09-22) answers `hostStatus: starting, pendingAction: spawn, processRecorded: false, condition: synchronizing` today. The live registry has 510 rows in exactly this shape. 496 of them are the current generation of their conversation. |
| #2028 live idle host `synchronizing` forever, relay refused | **still real** | See [#2028](#2028-a-parked-resume-fences-the-row-and-nothing-ever-settles-it). Lane f9b7638c's builder was fenced by resume `b13ea19c`, whose staged recovery is still `path-pending` with `checks: 0` eight days later. Ten staged recoveries are in that state, the newest from 2026-09-29T12:19Z. |
| #2046 first send to a resumed host fails, identical resend succeeds | **still real** | Same family, and still happening. The failed deliveries of 2026-09-26T06:04:29Z and 2026-09-29T12:19:02Z (`delivery failed and remains recoverable`, 4 and 3 attempts) each share their conversation with a `resume-successor` receipt created 1–3 s later that is stuck in staged recovery. Nothing in the send path waits for the resume's publication (`structuredRecovery.ts:318-331`, `structuredMessageDelivery.ts:1128-1154`, `:747-757`). The runtime journal has compacted those operations, so the builder's failing test (T4) must pin the exact terminal branch. |
| #2058 structured launch fails on a 3 s runtime timeout after a handoff | **still real** | Structured launch receipts that settled `failed` with `runtime host request timed out`: 5 on 2026-09-26 and 1 on 2026-09-27, all after identity staging, and none routed to staged recovery. The client budget is still 3 s (`client.ts:149`). Pre-staging runtime admission still retries only 3 times at 250 ms/500 ms backoff (`structuredSpawn.ts:60-61`, `:224-241`). The exact call that timed out was not recoverable, because the containers of those days are gone. |
| #1866 send to a reclaimed host `in-flight` for an hour, host never resumed | **still real** | The `send_message` lookup under the original key reads through `resolveOriginalSend`, which is read-only and never applies the settlement deadline (`sendSettlement.ts:817-835`, `bindings.ts:6009-6069`). Only `message_receipt` ends an overdue send (`sendSettlement.ts:36-56`). The pre-dispatch-uncertain returns above are how a message that was never dispatched reaches `in-flight`. MCP's dispatch attempt is 5 s (`bindings.ts:273`), so every send that has to resume a host outlives its dispatch and depends on the lookup. |

### #2020: the headless reviewer row never leaves `starting`

- `flows/engine.ts:694-720` (`settleReviewerSpawn`) settles every reviewer
  launch as `status: "starting", pendingAction: "spawn"`. For a headless
  reviewer (`:836`) the host is `null`. The receipt completes with the entry
  exactly as given (`registry.ts:5907-6153`, `settleSpawnInFile`).
- Nothing clears it afterwards:
  - `reconcileSpawnReceipts` (`registry.ts:6823-6835`) clears the marker only
    for live pane keys.
  - The startup repair `repairCompletedStructuredSpawnMarkers`
    (`registry.ts:6841-6896`) only covers structured launches with a live,
    identity-verified process.
  - `forgetHeadlessReview` at `flows/engine.ts:1287-1289` ends the process and
    leaves the registry row as it is.
- `deliverability.ts:117-125` reads any non-null `pendingAction` as
  `synchronizing`. What happens next:
  - **Live send.** With no runtime session and a condition that is not
    `reclaimed` (`structuredMessageDelivery.ts:866-880`),
    `holdDuringRuntimeSynchronization` finds no owner (the row has no
    `structuredHost`) and returns a 503 through `ownershipUnavailable`
    (`:347-353`) **without reserving anything**. Nothing is resumed.
  - **Held drain.** `deliverHeldStructuredMessage` returns `"held"` for
    `synchronizing` (`:742-744`), and `drainHeldDeliveries` requeues it with
    no bound (`coordinator.ts:1089-1091`).
- On the MCP side, a 503 carrying a JSON error and no `operationId` is a
  `McpDispatchVerdictError`. Once dispatch was attempted, the service cannot
  prove it was not executed (`server.ts:2763-2777`), so the claim stays
  unsettled. Every later lookup then reads `absent` from `recoverSend`
  (`bindings.ts:6034`) and answers `outcome_unknown` /
  `original-key-lookup`, with no end.

### #2028: a parked resume fences the row, and nothing ever settles it

Registry evidence for lane f9b7638c's builder conversation (`c830a05b…`):

- Its launch `41675038` completed at 19:49Z.
- At 20:11:24Z a `resume-successor`, `b13ea19c`, staged itself onto the row
  (`pendingAction: "spawn"`, `structuredHostOperationId: b13ea19c`). Its
  durable setup hit `runtime host request timed out` and parked as staged
  recovery `{phase: "unpublished", checks: 0}` (`structuredSpawn.ts:2254-2259`).
- From then on, the live process with the marker still set made
  `recoverCandidate` throw `StructuredRecoverySynchronizingError`
  (`structuredRecovery.ts:246-248`). That throw is the relay's "structured
  recovery is synchronizing while a live host owner remains".

Why the recovery never ran even once:

- `recoverStagedStructuredLaunch` refuses any pipeline member unless the
  pipeline engine passes `eligible` (`structuredSpawn.ts:1836-1839`).
- The engine's probe names only the current run stage's own
  `attempt.launchId` (`pipelines/engine.ts:4997-5013`). A `resume-successor`
  on a stage that already finished is never named.
- A recovery that does run and exhausts its budget is only flagged
  `stopped: true` (`structuredSpawn.ts:1851-1858`). The receipt stays
  `path-pending` and the row stays fenced.
- The replay reconciler that owns terminal bounds and host reaping
  (`reconcileStructuredSpawnReplay`, `:474-480`) hands every staged receipt
  back to `recoverStagedStructuredLaunch` before any of its bounds apply.

The same mechanism feeds #2046 and #1866. A send to a reclaimed conversation
starts a resume, the resume parks, the recovery path answers "structured
recovery host did not publish its transcript" (`structuredRecovery.ts:318`),
and the message fails or goes uncertain while the resume stays parked for
good.

## The plan

Seven changes, one per defect. None of them adds a timer, a store or a new
state. They reuse bounds and settlement functions that already exist.

### F1. A headless reviewer's marker ends with the reviewer (#2020)

- **`src/lib/agent/registry.ts`**: add `endHostlessSpawn(launchId)`. It
  applies only to the row this completed receipt settled, and only while that
  row has no `host`, no structured process and no `claimOwner`. It sets
  `status: "dead"` and `pendingAction: null`, and advances the migration
  scope revision the same way `terminateStructuredHost` does.
- **`src/lib/flows/engine.ts`**: call it wherever a headless round's reviewer
  is known to be gone:
  - the terminal-status branch at `:1287-1289`, right after
    `forgetHeadlessReview`;
  - the `lost` branch at `:1282-1286`, but only when the recorded
    `round.reviewerIdentity` reads `dead` from `processIdentityStatus`;
  - `retryHeadlessRound` (`:860`).

  The row then reads `reclaimed`, and the existing recovery resumes the
  reviewer's session like any other finished agent's
  (`recoverReclaimedMessage`).
- **Existing rows** (496 current ones): add
  `repairHostlessSpawnMarkers(isRunning)` beside
  `repairCompletedStructuredSpawnMarkers`, run at the same startup point. It
  applies the same clear to rows that meet all of these:
  - `pendingAction: "spawn"`;
  - no host, no structured process, no claim;
  - a completed `launch` receipt whose `transport` is `null`;
  - `isRunning(launchId)` is false. The flows module supplies `isRunning`: a
    round that names the launch and whose recorded reviewer identity is not
    `dead`.

  A reviewer that is still running keeps its fence, because resuming it would
  put a second writer on the same session.

### F2. A refusal before any reservation settles as not-executed (#2020, lookups)

- **`src/lib/runtime/structuredMessageDelivery.ts`** and
  **`src/lib/delivery.ts`**: every refusal returned before
  `holdDelivery`/`preflightDeliveryReservation` could have written anything
  carries `admission: "refused"`. That covers:
  - deputy refusal, image admission errors and `refusedIdempotencyKey`;
  - `legacyCommandUnavailable`;
  - `ownershipUnavailable` on the pre-hold paths (`:348-353`, `:877-887`);
  - `supersededRejection` in both files;
  - the injection refusals made before the hold.

  Refusals made after a reservation exists keep their `operationId` and stay
  as they are.
- **`src/app/api/conversation-host/handlers.ts`**: pass the field through.
- **`src/lib/mcp/bindings.ts`**: `dispatchViewerControl` copies `admission`
  into the verdict details. `sendMessage` turns a verdict with
  `admission: "refused"` and no `operationId` into
  `McpDispatchNotExecutedError`. The service already settles that error
  durably as `not-executed` / `new-request-permitted`, carrying the refusal's
  reason (`server.ts:2767-2790`), and replays it on every later lookup
  (`:2605`).

This is honest because the answer is the handler's own and was given after
the handler returned. Nothing under the downstream key existed, and a second
call under the same key meets the MCP claim first.

### F3. A resume is published or failed within 60 s (#2028, #2046, #1866)

- **`src/lib/runtime/structuredRecovery.ts`, `recoverCandidate`**: today a
  spawn result that is `ok` but staged (`state: "path-pending"`, no path) is
  thrown as "did not publish its transcript". Instead, drive that launch's own
  staged recovery in the loop described below, until its receipt is
  `completed` or `RESUME_PUBLICATION_BOUND_MS` has passed.
  - **The loop.** Call `recoverStagedStructuredLaunch(launchId, registry,
    client, { eligible: () => true })` once a second. Passing `eligible` is
    safe here: a resume carries no first message (`"prompt": ""`), so the
    probe can only publish the host and never dispatch anything.
  - **When the receipt completes,** return `spawned: true`.
  - **When the bound passes,** settle through a new
    `failStagedResume(launchId, reason)` in `structuredSpawn.ts` (F4) and
    throw `StructuredResumeUnpublishedError` with the reason "host resume did
    not publish within 60 s: <last staged reason>".
- **`RESUME_PUBLICATION_BOUND_MS = 60_000`.** A resume re-opens an existing
  session, so it has no first message and no transcript to wait for. It only
  has to publish. #2046's host came back 3 s after the send. #2058 measured
  individual runtime calls at about 4.6 s during a handoff, and a publication
  makes a handful of them. 60 s covers a handoff with margin. It stays far
  below the 10-minute send settlement window (`sendSettlement.ts:126`), so
  a failed resume is reported as its own failure, well before the deadline
  would settle the send as unverified.

### F4. A parked launch that nothing will advance is settled and its host retired (#2028)

**`src/lib/runtime/structuredSpawn.ts`**:

- **`failStagedResume(launchId, reason)`**, built from the existing
  fail-and-reap sequence of `reconcileStructuredSpawnReplay` (`:620-686`):
  1. `failStructuredSpawn` claims the terminal receipt first; that also
     clears the row's marker when `structuredHostOperationId` is this launch
     (`registry.ts:6428-6490`).
  2. Transition the runtime operation to `failed`.
  3. Release the registered host, or else stop the recorded process through
     `terminateVerifiedStructuredSpawnProcess`, guarded by the same
     still-owned checks.

  The conversation then reads `reclaimed` and the next attempt resumes
  cleanly. This is #2028's own "retires and resumes the host". An idle host
  of a finished stage loses nothing: its session lives in the transcript.
- **`recoverStagedStructuredLaunch`**:
  - Settle through `failStagedResume` in two cases: a `resume-successor`
    whose recovery is still `unpublished` and whose `startedAt` is more than
    `RESUME_PUBLICATION_BOUND_MS` ago with no local continuation in flight;
    and any recovery that is `stopped` or out of budget while still
    `unpublished`.
  - This check comes **before** the pipeline-membership gate and before the
    local-host/writer gate (`:1836-1848`). A recovery that no process can
    advance is exactly the one that must end.
  - The `uncertain` and `delivered` phases of a first-message launch keep
    today's rules, because their message may have been dispatched. Stage
    launches keep the engine's `failStageLaunch`.
- **Where it runs, with no new timer:**
  - the resuming caller (F3);
  - `recoverDeadStructuredConversation`: when `candidateFor` finds the row
    fenced by a `resume-successor` receipt that is overdue in this sense, it
    settles that receipt and re-reads the candidate before deciding
    `SynchronizingError`. The relay or drain that hits the fence clears it;
  - startup (`recoverPendingStructuredSpawns`), which settles the ten parked
    receipts already on disk.

### F5. A failure before dispatch keeps the message queued, within a bound (#1974 part 2, #1866, #2020 held)

- **`src/lib/runtime/structuredMessageDelivery.ts`,
  `deliverHeldStructuredMessage`**: change every return before
  `client.command` from `"delivery-uncertain"` to `"held"`. That is `:745`,
  `:757`, `:759`, `:769`, `:771` and `:774`. `drainHeldDeliveries` then
  requeues the reservation as unactuated (`requeueUnactuatedDelivery`) and
  keeps its message, attachments and operation id. A reservation already
  `delivery-uncertain` keeps that state, because `reconcileUncertain` never
  requeues (`coordinator.ts:1090`).
- **`src/lib/accounts/migration/coordinator.ts`, `drainHeldDeliveries`**: an
  unactuated reservation older than `SEND_SETTLEMENT_WINDOW_MS` (10 min,
  exported from `sendSettlement.ts`) is terminalized `failed`. Its reason
  names the last pre-dispatch cause (for example "not delivered in 10 min:
  host resume did not publish within 60 s") and it carries the `lost`
  disposition, which reads as safe to resend.
  - To make that possible, `deliverHeldStructuredMessage` returns the cause
    with `"held"`.
  - The migration controller's 60 s interval (`controller.ts:34`) guarantees
    the bound is noticed within a minute. The registry reservation is the
    fence the queue reads (`sendIsSettled`), so a late drain cannot deliver
    after the failure was reported.
- **Why 10 min.** It is the window the #1131 design already calls "generous
  enough that an ordinary drain, host recovery or reconnection finishes well
  inside it". With the same number, the drain's own failure and a receipt
  read agree on when a send is over.

### F6. The original-key lookup applies the settlement deadline (#1866)

**`src/lib/mcp/bindings.ts`, `recoverSend`**: when the found send is not
terminal and is past its settlement deadline, answer from
`resolveSendReceipt(operationId)` instead of the read-only projection. That is
the settling read `message_receipt` already uses. The first fences the
journal operation, then writes `failed` with an honest disposition
(`sendSettlement.ts:36-56`).

This amends the #1490 "recover is read-only" rule for overdue sends only, and
in the way #1131 intended: settlement happens where the question is asked.
It never dispatches, retries or resends. Before the deadline, the lookup
stays read-only as it is today.

### F7. Launch runtime calls ride out a handoff (#2058)

**`src/lib/runtime/structuredSpawn.ts`**:

- `withRuntimeAdmissionRetry` retries transport failures
  (`isRuntimeHostTransportFailure`) until a 30 s deadline, with backoff
  250 ms → 2 s, instead of 3 attempts. It already wraps the idempotent calls:
  the `spawn` command keyed by its operation id, and `transitionOperation`.
  - **Why 30 s.** The incident launch came about 30 s after a handoff, and
    calls were still taking about 4.6 s against a 3 s budget. 30 s of retries
    spans the new host's warm-up. It stays inside the 5-minute durable-setup
    bound and inside F3's 60 s for resumes.
- Write the `unpublished` staged-recovery record right after
  `stageStructuredSpawn` (`:2072`) instead of after `bindHost` (`:2112`). Then
  every transient failure after identity staging is routed to staged recovery
  (`:2254`), and F4 bounds it, instead of settling `failed` on the first
  timeout.
- Fence: this is the runtime-host socket inside an agent launch. It does not
  touch pipeline worktree provisioning, fetch or `deploy_exact_sha`.

### F8. The trigger migration is atomic (#1974 part 1)

**`src/lib/agent/sqliteRegistryStore.ts`**: the three multi-statement DML
blocks (`:506-517`, `:543-563`, `:565-569`) become arrays of complete
statements, each run with `db.run` inside one `db.transaction(...).immediate()`.
A statement failure then throws and rolls the whole block back. The two
`BEGIN IMMEDIATE … COMMIT` strings become the same transaction form.

## Exactly once across a host resume

- **One reservation, one operation id.** The live path reserves the whole
  message before it raises any host (`structuredMessageDelivery.ts:1100-1122`, `:1197`),
  keyed by `(conversation, clientMessageId)`. The resume and every retry reuse
  that reservation.
- **A resume dispatches nothing.** Its prompt is empty. F3's
  `eligible: () => true` is used only on the resume's own launch, so the probe
  can only publish the host.
- **One claim.** Dispatch happens only after `beginDeliveryAttempt` inside
  `withConversationActuation` (`:1257-1286`, `coordinator.ts:1080-1082`). The
  claim is exclusive, and the loser requeues. The journal also dedupes on
  `UNIQUE(conversation_id, idempotency_key)` and on the operation id.
- **Only an unactuated reservation is ever retried.** F5 returns `"held"`
  only for paths that never reached `client.command`, so the drain requeues a
  message that provably never left. Once dispatch starts, the outcome is
  `delivered`, `failed` or `delivery-uncertain`. The last is absorbing, as
  #1131 requires, and is never re-sent.
- **A reported failure stays true.** F5's bound, F4's settlement and F6's
  deadline read all terminalize through the registry reservation and the
  journal fence (`sendIsSettled`), so nothing arrives after a failure was
  reported.

## Regression tests (one per still-real issue, red on `ce8abf18b`)

Each test runs by path with an isolated `LLV_STATE_DIR`, and each is written
first and shown red on the merge base.

- **T1 #2020**, `src/lib/flows/engine.test.ts` plus
  `src/lib/agent/registry.sqlite.test.ts`:
  - A headless round whose reviewer process exits leaves the reviewer row
    `dead`, marker cleared. `conversationDeliverabilityFromRecord` then
    answers `reclaimed`, and `enqueueStructuredMessage` (fake runtime client,
    fake `recover`) reserves the message, returns its `operationId` and calls
    `recover` once.
  - A second case: the startup repair clears a pre-existing hostless row, and
    does not clear one whose round is still running.
  - Red on the merge base: the row stays `starting/spawn`, deliverability
    says `synchronizing`, and the send returns 503 with no `operationId`.
- **T2 #2020 lookups**, `src/lib/mcp/originalKeySendRecovery.test.ts`: the
  Viewer answers 503 `{error, admission: "refused"}`. The first answer and a
  later `recoveryOnly` lookup under the same key are both `not-executed` with
  the reason. Red: both `outcome_unknown`.
- **T3 #2028**, `src/lib/runtime/structuredSpawn.integration.test.ts`: a
  pipeline member's live, claimed row is fenced by a `resume-successor`
  receipt parked `unpublished` past 60 s. Running
  `recoverPendingStructuredSpawns`, or a relay through
  `deliverConversationMessage`, settles that receipt `failed` with a named
  reason and reaps the recorded process through the injected terminator. The
  held relay is then delivered by exactly one `client.command`. Red: the
  receipt stays `path-pending` and the relay gets
  `StructuredRecoverySynchronizingError`.
- **T4 #2046**, `src/lib/runtime/structuredMessageDelivery.test.ts`: a
  reclaimed conversation whose resume spawn first returns staged
  (`path-pending`) and publishes on the second probe. The **first**
  `enqueueStructuredMessage` delivers with exactly one command and no
  `failed`. Red: the first send fails with "did not publish its transcript",
  and an identical resend under a new key succeeds.
- **T5 #1866**, `src/lib/accounts/migration/coordinator.test.ts` plus
  `originalKeySendRecovery.test.ts`:
  - A drained reservation whose resume keeps failing stays unactuated with
    the same operation id, and at 10 min is `failed` with the resume's reason
    and the `lost` disposition.
  - A dispatched but unanswered send read by original-key lookup past its
    deadline answers `settled`.
  - Red: `delivery-uncertain` / `in-flight`.
- **T6 #1974 part 2**, `structuredMessageDelivery.test.ts`: the issue's own
  acceptance. The readiness read fails after republication, and the outcome
  is `"held"`, with message and attachment identities unchanged. Once
  readiness returns, there is exactly one delivery. Red:
  `"delivery-uncertain"`.
- **T7 #2058**, `structuredSpawn.integration.test.ts`: the runtime client's
  calls time out for the first 8 s of an injected clock, both before and just
  after identity staging. The launch completes. Red: the receipt settles
  `failed` with "runtime host request timed out".
- **T8 #1974 part 1**, `registry.sqlite.test.ts`: fault triggers on
  `registry_meta` (marker write) and on an intermediate statement. Opening the
  store throws, and the previous triggers, marker and rows are unchanged. Red:
  no throw, and the triggers are replaced.

## Project checks the build lane owes

- The touched test files, by path only. `bun test src/lib/agent/` and
  `src/app/api/runtime/` must never be swept against live state.
- `bunx tsc --noEmit` and `bun run build`, each under
  `flock /var/tmp/llv-heavy-gate.lock` with an isolated config root.
- `bun scripts/privacy-publication-gate.ts --base <merge-base>` before
  pushing.

No Bun pin changes, so `verify-runtime-host.ts` does not apply.

## Validation against the requirement

- **"delivered exactly once within a bounded wait":** F3 publishes the resume
  within 60 s, and the reservation is dispatched once after that (see
  [Exactly once](#exactly-once-across-a-host-resume)).
- **"or ends in a clear failure that names the reason":**
  - F2 answers not-executed with the refusal's own reason.
  - F3 and F4 fail with "host resume did not publish within 60 s: <cause>".
  - F5 fails with "not delivered in 10 min: <cause>".
- **"Nothing stays synchronizing":** F1 ends the headless marker, and F4 ends
  the parked-resume marker.
- **"… starting":** F1.
- **"… in-flight":** F5 ends it for sends that never dispatched, and F6 for
  every overdue send.
- **"… outcome_unknown":** F2.
- **"never fails first and succeeds on resend":** F3. The first send waits
  for the resume it caused.

## Deferred (not justified by the requirement yet)

- The same Bun 1.4.0 hazard in other multi-statement `exec` blocks:
  `runtime-host/nativeQueueJournal.ts:56`, `runtime-host/journal.ts:2881`,
  `search/transcriptSearch.ts:168-175`. They are startup migrations or index
  rebuilds outside this issue list. Worth an issue of its own.
- A background sweeper that settles overdue sends with nobody asking. #1131
  refuses one on purpose. F5 (drain bound) and F6 (lookup) cover every reader.
- Recording which runtime call timed out during a handoff. F7 makes the
  answer irrelevant to delivery.
- Legacy pane rows that still carry pane evidence. Pane transport is being
  removed (#2111).
- Closing #2002, which this lane does not do. `d992539b7` is the evidence
  for whoever closes it.
