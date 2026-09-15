# K6b plan: a lossless Cancel for account switches (#1695, #1705)

Status: implemented in the K6b pull request, on top of K6a (#1707, merged). The prepared tests below went
green with it; the pull request lists what else was added. K6a shipped the account chips and pickers without
Cancel or Change and reports a queued structured switch from the runtime session's `pendingReconfigure`, which
the runtime journal already projects for every page.

## What exists, and why every cancel path is unsafe today

A conversation's account switch is a `reconfigure` with `accountId` (`POST /api/conversation-host`). Its life:

1. **Admission.** The runtime journal queues the operation and publishes
   `pendingReconfigure {operationId, model, effort, fast, accountId}` on the session. A newer reconfigure
   replaces it. `appendCompletionConsequences` clears it when that operation is applied or failed, and never
   clears a newer one.
2. **Drain.** `drainReconfigure` does nothing while the host runs a turn, and later sends on the conversation
   wait behind it in the runtime queue. At the turn boundary it moves the operation to `applying` in the
   journal, then claims it in the registry (`claimConversationReconfigure`, one registry transaction).
3. **Reseat.** `requestConversationReseat(…, owner)` creates the conversation-scoped intent and the migration
   (`requested`, or `waiting-turn` while the registry still sees the turn busy) in a second transaction.
   `advanceConversationMigration` then moves it through `preparing`, `successor-starting`, `verifying`,
   `committed`. Its transitions check the expected phases; they do not bump `migration.revision`.
4. **Fencing.** From the moment the migration exists, a send is reserved in the registry as a held delivery
   (`holdDelivery` places it `held` while the phase is `requested` to `verifying`). A delivery admitted before
   the migration is `assigned` to the source generation. One that began an attempt is `delivery-uncertain`.

The defects, each reproduced in isolated tests on main 098932f8 (#1705):

- **Rollback is undone.** `rollbackConversationMigration` sets `rolled-back` and re-arms deliveries, but leaves
  the reconfigure `applying` and the intent `draining`. The queue retries the effect, the claim replays,
  `requestConversationReseat` accepts `rolled-back` and revives the intent by its `reconfigure:` request id,
  and the switch lands.
- **Supersede and failure destroy payloads.** A newer claim with another account runs
  `retireReconfigureOwnedMigration`, and a failed settle does the same. Both call
  `terminalizeCancelledMigrationDeliveries`, which fails every non-terminal delivery of the conversation and
  empties its `text`: held ones, ones assigned to the source before the migration existed, and uncertain ones.
- **No owner on a held delivery.** Rollback re-arms, and retire terminalizes, every non-terminal delivery of
  the conversation; nothing records which migration fenced which delivery.
- **Rollback has no phase check.** `rollbackConversationMigration` rolls back `preparing` or `verifying` too.
  `expectedRevision` does not fence phase progress, because phase transitions keep the revision.

## Design

### 1. Ownership of held deliveries
- **Record the owner.** When `holdDelivery` or a retry placement holds a delivery because a migration is in
  flight, it records `fencedBy: migration.operationId` in the same transaction.
- **Rightful deliveries.** A cancel, withdrawal or supersede touches only deliveries that are `held` and
  `fencedBy` the migration being retired. A legacy `held` row without `fencedBy` counts as fenced by the
  conversation's in-flight migration, the only thing that holds a delivery.
  - Deliveries `assigned` to the source generation, `delivery-uncertain`, `delivered` or `failed` are never
    touched.
- **Re-arm preserves the payload.** It sets `state: assigned` and `generationId` to the source generation.
  It keeps `text`, images, `command.operationId`, `clientMessageId` and `attempts`, so the delivery keeps its
  idempotency identity and reaches its one terminal outcome through the ordinary delivery path. Nothing in
  K6b writes `failed` to a delivery.
- **Supersede to another account adopts.** The fenced deliveries stay `held`, and `fencedBy` moves to the new
  migration inside the `requestConversationReseat` transaction that creates it. If the superseding
  reconfigure ends before it creates a migration (withdrawn, failed preflight, cancelled), its settlement
  re-arms the deliveries still fenced by a migration no longer in flight.
- **Supersede back to the source account** retires the migration like a cancel: fenced deliveries are
  re-armed, never failed.
- **Unchanged: a switch that commits.** `commitSuccessor` still ends the deliveries left pending at commit with
  "its owning account migration committed; send again" (covered by `registry.reseat.test.ts`). K6b changes only
  what a cancel, withdrawal, supersede or failure does to them.

### 2. Withdrawing a queued switch, atomically against its claim
- **Registry.** `withdrawConversationReconfigure(conversationId, operationId)` runs in one transaction:
  - `conversation.reconfigure.operationId === operationId`: answers `claimed` and writes nothing. It never
    fences an operation the registry already owns.
  - A withdrawal already recorded for it: answers `replayed`.
  - Otherwise: records the operation in a bounded `reconfigureWithdrawals` list and answers `withdrawn`.
- **Claim.** `claimConversationReconfigure` checks `reconfigureWithdrawals` first, in its own transaction,
  and answers `withdrawn`. It writes no profile, and it retires or transfers no older owner.
  `applyStructuredReconfigure` then rejects with a cancelled error before any reseat.
- **Serialization.** The two are registry transactions, so exactly one order happens:
  - withdraw first: the claim finds the fence, nothing is claimed, and the operation fails once as
    `cancelled`;
  - claim first: the withdrawal answers `claimed`, nothing is written, and the switch continues until a
    claimed cancel (3) with the migration's revision.
- **Queue.** Before its turn check, `drainReconfigure` reads the fence and fails a withdrawn operation at
  once with reason `cancelled`. The same fence is checked again inside the claim, and
  `transitionUnlessSettled` keeps the journal to one terminal transition. The route kicks the queue after a
  withdrawal. The journal's failed transition clears `pendingReconfigure`.
- **Held deliveries.** A queued switch has no migration, so no registry deliveries are fenced by it. Later
  sends waiting behind it in the runtime queue proceed in order once it fails.

### 3. Cancelling a claimed switch
- **Registry.** `cancelConversationSwitch(conversationId, expectedRevision)` runs in one transaction:
  - it needs a migration, with `revision === expectedRevision` (else stale) and a phase of `requested` or
    `waiting-turn` (else started);
  - it sets `rolled-back`, stops the conversation-scoped intent and applies `migrationOptOut` as rollback does;
  - if the intent carries the `reconfigure:` request id of the applying reconfigure, it settles that
    reconfigure `cancelled` (a new terminal status) and restores its `previousProfile`;
  - it re-arms the deliveries fenced by that migration (1).
- **Queue retry.** The claim replays a `cancelled` owner, and `applyStructuredReconfigure` rejects without a
  reseat. The operation fails once as `cancelled`.
- **Coordinator.** A coordinator advancing concurrently finds `rolled-back` in its expected-phase check and
  stops; no successor is created.

### 4. The route contract
Existing contract of `POST /api/conversations/:id/migration`:
- `reseat` (optional `path`);
- `rollback` and `retry`, each with a required non-negative integer `expectedRevision`;
- anything else answers 400, a stale revision answers 409.

Additive changes, with no existing guard weakened:
- **`cancel {expectedRevision}`** is the claimed cancel of 3. It is never accepted without `expectedRevision`.
- **`withdraw {operationId}`** is the withdrawal of 2, for a switch not yet claimed. It is never accepted
  without a non-empty `operationId`, and it never touches a migration.
  - The route first reads the operation from the runtime host. It must be a `reconfigure` of this
    conversation in `queued` or `applying`; otherwise 404 or 409. Unreadable gives 503, with nothing written.
  - An operation already claimed answers 409 `SWITCH_CLAIMED`, with the migration revision once one exists.
- **`rollback`** keeps its guard. For a reconfigure-owned migration in `requested` or `waiting-turn` it runs
  the cancel of 3, so the MCP tool's rollback stops being undone (#1705). In every other phase it is unchanged.
- **Codes.** 400 malformed, 404 unknown conversation or operation, 409 with `code` (`MIGRATION_STALE`,
  `SWITCH_STARTED`, `SWITCH_CLAIMED`), 503 runtime unreadable.
- **MCP.** `conversation_migration` gains `cancel` and `withdraw`, with `operationId` described in its schema.

### 5. Client (kanban board)
- The picker's Pending row offers **Cancel switch**:
  - `withdraw {operationId}` when the runtime session reports a queued switch;
  - `cancel {expectedRevision}` when the migration record is `requested` or `waiting-turn`;
  - none from `preparing` onwards.
- A 409 `SWITCH_CLAIMED` reads again and offers the claimed cancel once the record shows.
- **Change** is a Cancel followed by a new switch once the cancel is confirmed.
- Unknown outcomes stay read-only and are never resent.

### Dropped
A separate `pendingSwitch` projection: `pendingReconfigure` in the runtime session is already the durable
pending target.

## Regression required for K6 completion
A stage conversation whose account is switched settles its stage on its own verdict with no `onFail`
activation:
- its attempt keeps its conversation id across the successor generation;
- the verdict lands in the successor transcript;
- the stage passes, the fail edge's round count stays 0, and no stage starts from `onFail`.

## Prepared tests (red on main before K6b)
`src/lib/runtime/structuredSwitchCancel.test.ts` is built on the account-switch fixture. Its source
conversation holds:
- a delivery assigned before the switch;
- a delivery that began an attempt (uncertain);
- a delivery held during the waiting switch.

Cases:
1. **Claimed cancel.** Rolled back, owner cancelled, profile restored, intent stopped. Only the held delivery
   is re-armed, with its text and operation id intact; the assigned and uncertain ones are unchanged. The queue
   retry rejects as cancelled and the conversation stays on its account.
2. **Cancel guards.** A stale revision and a `preparing` migration each refuse with nothing changed.
3. **Withdraw first.** Nothing is claimed, the profile is untouched, a replayed withdrawal answers `replayed`,
   and no migration is created.
4. **Claim first.** The withdrawal answers `claimed`, writes nothing, and the migration stays `waiting-turn`.
5. **Supersede to another account.** The held delivery stays held with its payload and is owned by the new
   migration. Nothing fails.
6. **Supersede back to the source.** The held delivery is re-armed with its payload. Nothing fails.
7. **Route contract.** `cancel` without `expectedRevision` and `withdraw` without `operationId` answer 400;
   `rollback` still requires `expectedRevision`.

## Ownership checked on 2026-09-15 (read-only)
- **Live agents:** `agent_activity` shows no Live Log Viewer conversation working other than this lane's.
  Every open Viewer pipeline is `needs_decision` or `paused`.
- **Open PRs on these files:**
  - #1689 and #1667 touch `registry.ts` and `structuredDeliveryQueue.ts`, but only the delivery effect union
    and its dispatch line.
  - #1613 and #1571 touch the queue elsewhere; #1250 touches `registry.ts` and `types.ts`.
  - None touches `structuredReconfigure.ts`, `structuredControls.ts`, `conversationCommand.ts` or the
    migration route.
- **Uncommitted edits in other worktrees**, all dormant, preserved and untouched:
  - `registry.ts`: pipeline 2abda855 (2026-09-07), pipeline 310d0e93 (2026-09-05), and the
    `hotfix/sqlite-delivery-point-reads` worktree (2026-07-22);
  - `migration/coordinator.ts`: `hotfix/bridge-legacy-claude-structured-resume` (2026-07-22).
- **Integration order:** K6a (#1707) first, then K6b from the main that holds it. If #1689 or #1667 lands
  first, main is merged in and the adjacent union lines resolved.

## Review
DATA bar: registry, runtime queue and delivery. An independent review of the implementation head is required
before merge, spawned by the root. This lane launches no reviewer or helper.
