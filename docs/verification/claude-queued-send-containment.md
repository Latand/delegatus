# Claude queued-send containment

Issue #2741 follows the queued-send admission enabled by #2694. The broker
allocated a turn slot for each input and shifted one slot per result. Claude
can echo several inputs before one result, leaving an already-consumed input
as a phantom active turn. Subsequent interrupt-active sends then wait behind
that turn. The installed CLI can also combine two queued payloads into one
canonical replay frame, which does not establish a separate identity for each
input.

The urgent repair sets Claude's `supportsQueuedSend` to `false`. The existing
`StructuredDeliveryQueue` keeps queue and steer-or-queue operations in the
journal while Claude is active or awaiting permission. Each input is written
only after idle, confirmed under its original operation, and completed by its
own result boundary. Permission answers and explicit interrupts keep their
existing control path. An explicit operator interrupt-active replacement
passes queued agent follow-ups, including across the incumbent's transition
back to idle. The follow-up stays in its original journal slot until the
replacement reaches its terminal boundary. Native batching remains deferred
pending authoritative per-input identity evidence tracked in #2742.

## Evidence

All checks used explicit isolated HOME, XDG_CONFIG_HOME, TMPDIR and
LLV_STATE_DIR roots and the owned gate runner. No production state, account
credentials, transcript excerpts or agent controls were used.

- Original broker reproduction: several per-input replay echoes followed by
  one result left an already-confirmed input active in all four completion,
  interruption and permission variants.
- Final containment regression with the unchanged base broker: all five
  cases failed because a second input reached stdin during the incumbent
  turn. With containment, all five passed through the real broker,
  `StructuredDeliveryQueue`, `RuntimeJournal` and engine-event projection.
- The final cases cover two batches, three pending follow-ups per batch,
  queued images, a replacement executor, idempotent operation replay,
  permission answer and expiration, explicit interruption, and a subsequent
  interrupt-active image send from idle. Reopened delivery records retain
  each original payload and canonical confirmation under its original ID.
- The operator-replacement regression covers `queue` and `steer-or-queue`
  predecessors from agent, operator, and absent-origin legacy operations. The
  message-origin schema accepts operator and agent origins; absent origin is
  retained for legacy operations, while `system` is rejected by its parser.
  Each combination runs with an active incumbent and with a fresh permission
  request awaiting a response. Claude continues to declare
  `supportsQueuedSend=false`.
- Each case queues two original sends (text and image) before an explicit
  operator `interrupt-active` replacement. It verifies one interruption
  control, then checks that the first user stdin frame after the incumbent
  result is the replacement. Both queued receipts and payloads remain intact
  through the replacement's terminal boundary. The two sends then deliver once
  each, with their original images, and operation replay remains idempotent
  across replacement queue executors.
- Installed Claude CLI 2.1.284, using synthetic authentication and responses
  from a loopback port-0 Messages API: three direct inputs produced a seed
  replay and a combined two-payload replay. Only the seed receipt was
  confirmed; the combined frame did not falsely confirm either queued input.
- With the real queue admission path, three pending operations and a subsequent
  send produced four input writes, four distinct canonical confirmations,
  four result boundaries, zero interrupt requests, and idle broker/journal
  state. The native cases passed without a real provider or account.

The native test is opt-in:

```sh
sandbox=$(mktemp -d)
mkdir -p "$sandbox/home" "$sandbox/config" "$sandbox/tmp" "$sandbox/state"
HOME="$sandbox/home" XDG_CONFIG_HOME="$sandbox/config" \
TMPDIR="$sandbox/tmp" LLV_STATE_DIR="$sandbox/state" \
LLV_CLAUDE_BINARY="$(command -v claude)" \
bash scripts/gate-slot.sh bun test src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts
```

Focused verification also runs
`src/lib/runtime/claudeStreamBrokerHost.test.ts` and
`src/lib/runtime/structuredDeliveryQueue.test.ts` by explicit path, types with
`bunx tsc --noEmit`, and `bun run privacy:check`.

## Limits

This contains future queue admission. It does not mutate, migrate or replay
inputs already handed to a live CLI, clear an existing phantom turn, or repair
ambiguous native-batch receipts. The original receipt/image records remain
intact. Existing affected hosts require a separately authorized operational
recovery. Native protocol evidence is specific to the installed CLI version;
subscription/provider behavior and other CLI versions were not exercised.
