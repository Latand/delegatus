# K6b plan: a lossless Cancel and a durable pending target for account switches (#1695, #1705)

Status: plan. Nothing here is implemented. K6a (#1707) shipped the account chips and pickers without Cancel,
without a change of a pending switch's target, and with a queued switch's target known only to the page that
sent it. K6 is complete only when this lands with the regression below.

## Why

A conversation's account switch is a `reconfigure` with `accountId` (`POST /api/conversation-host`). Three
facts, each reproduced in isolated tests on main 098932f8 (fixture `switchRequestedMidTurn` in
`src/lib/runtime/structuredAccountSwitch.test.ts`), make every existing cancel path unsafe:

1. **Rollback is undone.** `rollbackConversationMigration` sets the migration to `rolled-back` and re-arms
   held deliveries. It leaves `conversation.reconfigure` `applying` and the conversation-scoped intent
   `draining`. `drainReconfigure` then retries the same effect. The claim replays,
   `requestConversationReseat(…, owner)` accepts the `rolled-back` phase and revives the intent by its
   `reconfigure:` request id, and when the turn ends the conversation lands on the target anyway.
2. **Superseding cancels held messages.** A newer `reconfigure`, to a third account or back to the source,
   claims over the pending one. `retireReconfigureOwnedMigration` stops the intent and calls
   `terminalizeCancelledMigrationDeliveries`: every held message fails ("send again to authorize a fresh
   delivery"). Switching back also releases and restarts the host at the turn boundary.
3. **A queued switch has no record.** While the host runs a turn, `drainReconfigure` returns before
   claiming, so there is no migration and no `conversation.reconfigure` yet. The runtime receipt carries no
   account, and `/api/files` projects nothing about it.

## Scope

### Server

1. **Rollback settles its owner.** When `rollbackConversationMigration` rolls back a migration whose intent
   carries the `reconfigure:` request id of `conversation.reconfigure` (status `applying`), the same registry
   mutation:
   - stops the conversation-scoped intent;
   - settles the reconfigure as cancelled, a new terminal status distinct from `failed` so nothing retries
     or restores it as a failure;
   - restores the previous launch profile the claim wrote;
   - re-arms held deliveries, as rollback already does, with uncertain ones keeping the existing
     cancellation.

   A later retry of that effect finds its owner cancelled and settles the runtime operation as `failed`
   (reason "cancelled"), requesting nothing.
2. **Withdraw a queued switch.** A switch not yet claimed is withdrawn through the existing conversation
   migration route with a new action, `POST /api/conversations/:id/migration {action: "cancel",
   operationId}`. The route records a withdrawal fence for that operation in the registry. The claim checks
   the fence and settles the effect cancelled before it requests a reseat. If the switch has already been
   claimed, `cancel` is the rollback of item 1, guarded by `expectedRevision`. No runtime-host protocol
   change: the queue runs in the Viewer process and already transitions operations itself.
3. **Change without loss.** A newer `reconfigure` that supersedes a pending one re-arms held deliveries to
   the source generation, as rollback does, instead of terminalizing them. The new switch then fences new
   deliveries under its own migration. `retireReconfigureOwnedMigration` keeps its intent stop.
4. **A durable pending target.** `dispatchStructuredControl` records the accepted switch on the conversation
   (`pendingSwitch {operationId, targetAccountId, requestedAt}`) in the same step that attributes #1279
   choices. Claim, settle, cancel and withdrawal clear it. `/api/files` projects it on the `FileEntry`
   beside `migration`, so every page shows "Current: A · next turn: B" for a queued switch too.
5. **MCP.** `conversation_migration` gains `cancel` with `operationId`, described in its schema.

### Client (kanban board)

- The picker's Pending row offers **Cancel switch** while the switch is queued, `requested` or `waiting-turn`.
  From `preparing` onwards it shows "switching…" without Cancel.
- A row click while pending is **Change**: the newer `reconfigure` with the lossless supersede of item 3.
- The chip and picker read the projected `pendingSwitch`, so the "known to this page only" note goes.
- Unknown outcomes stay read-only: a cancel with no answer is "not confirmed" and is never resent.

### Regression required for K6 completion

A stage conversation whose account is switched settles its stage on its own verdict with no `onFail`
activation. Planned as a new test file beside `stageHostGenerationClose.integration.test.ts`:
- a run stage's attempt conversation migrates to a successor generation (same conversation id, new
  transcript under the target account);
- its verdict lands in the successor transcript;
- the stage passes on that verdict, the fail edge's round count stays 0, and no successor stage starts
  from `onFail`.

## Tests

Registry and runtime, isolated state, by path:
- `registry.reseat.test.ts`: a rollback of a reconfigure-owned migration settles the owner cancelled, stops
  the intent, restores the previous profile and re-arms held deliveries.
- `structuredAccountSwitch.test.ts`:
  - rollback, then the queue retry: stays `rolled-back`, and the held delivery stays `assigned` (the repro
    in #1705 turned green);
  - a withdrawn queued switch never claims;
  - a supersede re-arms held deliveries;
  - switching back no longer fails held messages.
- `conversationCommand` and route tests: `cancel` by operation id (queued) and by revision (claimed); a
  stale revision gives 409; an unknown operation gives 404; a malformed body gives 400.
- `/api/files` response test: `pendingSwitch` is projected while queued and gone after settlement.
- MCP schema parity test for `conversation_migration` `cancel`.
- Kanban DOM and browser tests: Cancel and Change bodies, pending target from the projection on a fresh
  page, cancel with no answer never resent, and the prototype's `account-pending` frame compared including
  Cancel.

Red checks: remove each fence (owner settle, withdrawal check, re-arm on supersede, projection) in turn; the
named tests fail.

## Ownership checked on 2026-09-15 (read-only)

- **Live agents:** `agent_activity` shows no Live Log Viewer conversation working other than this lane's.
  Every open Viewer pipeline is `needs_decision` or `paused`.
- **Open PRs on the files above:**
  - #1689 and #1667 (native Codex injection) touch `registry.ts` and `structuredDeliveryQueue.ts`, but only
    the delivery effect union and its dispatch line, next to `reconfigureEffect`. Neither changes reconfigure,
    rollback, reseat or held-delivery code.
  - #1613 and #1571 touch `structuredDeliveryQueue.ts` elsewhere.
  - #1677 touches `src/app/api/files/response.ts`; #1250 touches `registry.ts` and `src/lib/types.ts`.
  - None touches `structuredReconfigure.ts`, `structuredControls.ts`, `conversationCommand.ts` or the
    migration route.
- **Uncommitted edits in other worktrees**, all dormant; they stay untouched and K6b rebases nothing onto
  them:
  - `registry.ts`: pipeline 2abda855 (2026-09-07), pipeline 310d0e93 (2026-09-05), and the
    `hotfix/sqlite-delivery-point-reads` worktree (2026-07-22);
  - `migration/coordinator.ts`: `hotfix/bridge-legacy-claude-structured-resume` (2026-07-22).
- **Integration order:** K6a (#1707), then K6b from the main that holds it. If #1689 or #1667 merges first,
  K6b merges main in and resolves the adjacent union lines.

## Review

DATA bar: runtime, registry and delivery. An independent review of the implementation head is required
before merge, run as its own review stage. This lane launches no reviewer or helper itself.
