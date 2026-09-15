# K6c plan: messages survive a successful account switch (#1695)

Status: plan with a failing repro. Nothing is implemented. The fix touches the registry and migration files
under review in #1708, so it waits for that pull request.

K6 requires that a conversation switched to another account keeps what the operator sent. Today it does not.

## What happens today

`commitSuccessor` (`src/lib/agent/registry.ts`) commits a switch and, in the same transaction, calls
`terminalizeCancelledMigrationDeliveries(file, conversation, COMMITTED_MIGRATION_DELIVERY_REASON)`. Every
delivery of the conversation that is not yet delivered or failed becomes:
- `failed`, with "delivery cancelled because its owning account migration committed; send again to authorize a
  fresh delivery action";
- with `text` emptied and `generationId` cleared;
- with the delivery operation owner settled as `lost`, or `unverified` for an uncertain one.

Nothing is delivered to the successor, and the text is gone, so the operator cannot even copy it to send it
again.

**History.** Before 96007ed5 (PR #759, "bound stale intents and cancel held input"), commit re-assigned `held`
deliveries to the successor. PR #759 replaced that with the cancellation above. It records no reason, and
`registry.reseat.test.ts` ("a successful migration preserves both prior and fenced prompts as cancelled
evidence") pins the new behavior.

**Repro** (`src/lib/runtime/structuredSwitchCommitMessages.test.ts`, isolated registry and board files, no host
or account). A structured conversation on account A running a turn requests a switch to B (`waiting-turn`); the
turn ends; the queue runs the switch again and it commits. The test fails, identically on #1708's head 04d53556
and on main fdc693e1 (tree 18df9473):

| Delivery | Before commit | After commit today |
| --- | --- | --- |
| Sent while the switch waited, never attempted | `held`, attempts 0, text kept | `failed`, `text: ""` |
| Sent before the switch, never attempted | `assigned` to the source, attempts 0 | `failed`, `text: ""` |
| Held again after an earlier attempt | `held`, attempts 1 | `failed`, `text: ""` |

## Evidence the fix may rely on

Every path that actuates a delivery claims it first with `beginDeliveryAttempt`, which moves it to
`delivery-uncertain` and increments `attempts` before any command is sent:
- structured send: `src/lib/runtime/structuredMessageDelivery.ts`, before `client.command`;
- migration drain: `drainHeldDeliveries` in `coordinator.ts`;
- legacy delivery: `src/lib/delivery.ts`;
- runtime HTTP retry: `src/lib/runtime/http.ts`.

A `delivery-uncertain` delivery also blocks the successor from starting (`successorCreationReady`), so none is
pending at commit. After commit, `reconcileMigrations` drains the `assigned` deliveries of a committed
conversation.

So, from registry state alone:
- **`held` with `attempts === 0`** was never actuated. No command for it reached any host.
- **`assigned` with `attempts === 0`** was never claimed either, but it was admitted to the source generation
  before the switch.
- **Anything with `attempts > 0`**, or with an owner whose disposition is `unverified`, may have reached a host.

## Contract

1. **Carry the safe ones.** At commit, a delivery that is `held`, has `attempts === 0`, and is fenced by the
   committing migration (or by nothing, for legacy rows) moves to the successor:
   - `state: assigned`, `generationId` the successor, `assignedAt` the commit time, `fencedBy: null`;
   - `text`, images, `command` (operation id, origin), `clientMessageId`, `requestDigest` and `attempts` unchanged;
   - the owner record stays unsettled.

   It is then delivered once through the ordinary drain, and its original operation id keeps journal
   idempotency, so a repeated drain cannot duplicate it.
2. **Never replay the rest automatically.**
   - Deliveries with `attempts > 0`, any uncertain history, or an owner disposition already set still end at
     commit: `failed` with the commit reason and owner disposition `lost` or `unverified` as today.
   - They now keep their payload and identity (`text`, images, `command`, `clientMessageId`, `attempts`), so the
     conversation can offer an explicit Send again. That is a new send with a new client id, through the existing
     release of a failed reservation's client message id. Nothing sends them without the operator.
3. **`assigned` before the switch with `attempts === 0` is an explicit decision.**
   - The evidence above says it was never actuated, so carrying it is safe from duplication. It was, however,
     addressed to the source account's turn.
   - Default in this plan: treat it like (2), not delivered automatically, payload kept, explicit resend. The
     narrower guarantee is "held while waiting ⇒ delivered after the switch".
   - The alternative (carry it too) needs one line in the classifier and the same tests inverted. This is the
     root's call before implementation.
4. **Receipts stay truthful.**
   - A carried delivery's operation answers `queued`, then `delivered`, as the drain settles it.
   - A not-replayed one answers `failed`, with the commit reason and its kept text.
   - No delivery ends twice: carried ones are never marked failed, and not-replayed ones are never re-armed.
5. **Copy.** The picker's pending note "Messages sent meanwhile are held for the switch." becomes true once (1)
   lands, because they are then delivered after it. Until then the #1708 follow-ups correct the note and the PR
   description.

## Scope
- **`registry.ts`:** `commitSuccessor` classifies instead of calling `terminalizeCancelledMigrationDeliveries`,
  and the commit-time terminalization keeps the payload. `terminalizeCancelledMigrationDeliveries` keeps its
  current behaviour for its other callers (retire account, stopped intents, commit of an engine-wide intent).
- **`contracts.ts` / normalization:** no new fields; `fencedBy` comes from #1708.
- **Tests:**
  - `structuredSwitchCommitMessages.test.ts`: the repro above, green, plus a carried delivery settling
    `delivered` once through `reconcileMigrations` with a recording port, without a manual drain.
  - `registry.reseat.test.ts`: the pinned "cancelled evidence" test changes. Its fenced prompt is carried, and
    its predecessor-owned prompt ends failed with its payload kept.
  - A test per actuation path (structured send, drain, legacy, HTTP retry) that no command is sent for a
    reservation before `beginDeliveryAttempt`, pinning the evidence the classifier relies on.
  - Kanban: the picker note and a composer Send again for a commit-failed delivery with kept text, if the
    composer does not already offer one (to verify).
- **Red checks:** classify everything as carry (the attempted and assigned cases go red), classify nothing as
  carry (the held case goes red), empty the payload again (the kept-payload assertions go red).

## Ownership and order
- These files are under review in #1708 (`registry.ts`, the migration coordinator tests). K6c starts after
  #1708's review settles and it merges, from that main, with ownership re-checked.
- #1689 and #1667 touch `registry.ts` only at the delivery effect union.
- No runtime host protocol change. No real account switch in any test.
