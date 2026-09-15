# K6b plan: Cancel and Change for a pending account switch (#1695, #1705)

Status: implemented in the K6b pull request, on top of K6a (#1707, merged). The prepared tests below went
green with it; the pull request lists what else was added, and "Review follow-ups" below what its independent
review changed. K6b covers cancelling a switch. What a switch that completes does to the messages sent for it
is #1709 (K6c), and K6 is not complete without it. K6a shipped the account chips and pickers without
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
  that the migration being retired held (`migrationHeldDelivery`):
  - a delivery `fencedBy` that migration's operation; a fence naming any other operation is not its own;
  - a legacy `held` row without `fencedBy` only when the migration's intent is the conversation's own and the
    row was admitted after that intent began. Any other legacy row is left exactly as it is.
  - Deliveries `assigned` to the source generation, `delivery-uncertain`, `delivered` or `failed` are never
    touched.
- **The rolled-back sweep counts only that residue.** The migration tick, the reaper and a stopped intent fail
  a rolled-back migration's deliveries only when that migration held them, and only inside #972's
  latest-admission window. After a cancel, a delivery assigned before the switch or an uncertain one stays for
  its own delivery or journal settlement.
- **Re-arm preserves the payload.** It sets `state: assigned` and `generationId` to the source generation.
  It keeps `text`, images, `command.operationId`, `clientMessageId` and `attempts`, so the delivery keeps its
  idempotency identity and reaches its one terminal outcome through the ordinary delivery path. Nothing in
  K6b writes `failed` to a delivery.
- **Supersede to another account keeps, then adopts.** The claim of the newer switch retires the old migration
  and records `keepsHeldFrom`, the retired operation, on its own reconfigure state. Until its migration exists
  (after its account check), no sweep takes those deliveries, and the record survives a registry reload. The
  `requestConversationReseat` transaction that creates its migration moves their `fencedBy` to it. If the newer
  switch ends before it creates a migration (failed preflight, a settings change or a switch back), they go
  back to the source, or to a migration another request put in flight.
- **Replacement and retry keep them too.** A migration that replaces an in-flight one, and a retry that mints a
  new operation identity, move the held deliveries of the one they replace under the new operation.
- **Supersede back to the source account** retires the migration like a cancel: fenced deliveries are
  re-armed, never failed.
- **Unchanged: a switch that commits.** `commitSuccessor` still ends the deliveries left pending at commit with
  "its owning account migration committed; send again", and empties their text (covered by
  `registry.reseat.test.ts`). That loss is #1709, for K6c. K6b changes only what a cancel, withdrawal,
  supersede or failure does to them.

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
  - it re-arms the deliveries that migration held (1);
  - the same cancel again, for a switch this revision already cancelled, answers `replayed` and writes nothing,
    and a rolled-back migration that no cancel ended throws "switch is no longer pending".
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
  - An operation already claimed answers 409 `SWITCH_CLAIMED`, with `expectedRevision` once the switch's own
    migration exists and `null` before.
  - The same withdrawal again answers `replayed`, also after the queue failed the withdrawn operation.
- **After a committed cancel or withdrawal**, a failure to kick the queue or deliver what was re-armed is left
  to the next pass and never changes the answer.
- **`rollback`** keeps its guard. For a reconfigure-owned migration in `requested` or `waiting-turn` it runs
  the cancel of 3, so the MCP tool's rollback stops being undone (#1705). In every other phase it is unchanged.
- **Codes.** 400 malformed, 404 unknown conversation or operation, 409 with `code` (`MIGRATION_STALE`,
  `SWITCH_STARTED`, `SWITCH_NOT_PENDING`, `SWITCH_CLAIMED`), 503 runtime unreadable.
- **MCP.** `conversation_migration` gains `cancel` and `withdraw`, with `operationId` described in its schema;
  its refusal carries `code` and `expectedRevision`.

### 5. Client (kanban board)
- The picker's Pending row offers **Cancel switch**:
  - `withdraw {operationId}` when the runtime session reports a queued switch;
  - `cancel {expectedRevision}` when the migration record is `requested` or `waiting-turn`;
  - none from `preparing` onwards.
- A 409 `SWITCH_CLAIMED` reads again and offers the claimed cancel once the record shows.
- **Change** is a Cancel followed by a new switch once the cancel is confirmed.
- Unknown outcomes stay read-only and are never resent. The lock names its switch (intent, revision and target,
  or operation) and ends once the board no longer shows that switch as cancellable, without claiming the
  cancel succeeded; a later switch is not locked by it.
- While a recorded switch waits, the picker says messages sent now are held, that Cancel delivers them on the
  current account, and that they are not delivered if the switch completes (#1709).

### Dropped
A separate `pendingSwitch` projection: `pendingReconfigure` in the runtime session is already the durable
pending target.

## Regression required for K6 completion
K6b adds this at engine scope only: the test gives the engine the conversation's new path, host availability
and the successor's turns, and runs no registry migration, commit or delivery. The integration, a real switch
whose successor turn is started by the message held for it, comes with K6c (#1709). A stage conversation whose
account is switched settles its stage on its own verdict with no `onFail` activation:
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

The review of 04d53556 found no P0. Its follow-ups, with focused tests only:
- **P2, the sweep after a cancel.** It failed pre-switch assigned and uncertain deliveries; the sweep now counts
  only what the migration held.
- **P2, the supersede gap.** A tick, the reaper or a restart before the newer switch's migration existed failed
  the kept deliveries; `keepsHeldFrom` now protects them.
- **P3, the owner filter.** It never filtered; it is now narrow, with legacy rows proven or left alone.
- **P3, the cancel lock** is bound to its switch. **P3, repeats and errors after commit** answer truthfully.
  **P3, MCP** carries code and revision. **P3, the engine regression** is renamed to its scope.
