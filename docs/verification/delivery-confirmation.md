# Delivery confirmation recovery

A message can arrive while its HTTP answer is lost and its receipt is absent
from the recent snapshot. Previously, expiry of the composer's confirmation
window left that message unconfirmed indefinitely: automatic operation reads
needed an operation ID that the lost answer never supplied.

The mounted composer now observes unresolved text and attachment attempts by
their original conversation and client key every 15 seconds. Automatic reads,
Re-check and the original-key recovery action share one request, bounded to
10 seconds. Hidden or inactive views release their reads. A canonical answer
enters both durable payload storage and the live receipt projection; returning
to a view also projects evidence saved while it was away. Receipt ordering,
terminal outcomes, newer drafts and unrelated errors remain authoritative.
An unknown answer retains the attempt and sends nothing. Authoritative
non-execution preserves the message and permits an explicit later retry.

The focused lost-answer regression fails on main baseline `f2e3c3858` with
`Expected: "delivered"; Received: "failed"`. The fixed case recovers without
another send. Its sibling cases cover receipt-service failure, retained image
bytes, Retry before confirmation, a check sharing a held automatic read,
visibility, inactivity, remount, transcript-path migration, conversation
changes, stale revisions and a hide during confirmation or non-execution
persistence.

The following explicit files were run separately through the shared gate,
each process with private HOME, XDG config, TMPDIR, CLAUDE_CODE_TMPDIR and state:

| Test file | Passing tests |
| --- | ---: |
| `src/components/TmuxComposer.admissionRecovery.dom.test.tsx` | 12 |
| `src/hooks/runtimeAdmissionObservation.test.ts` | 7 |
| `src/components/TmuxComposer.reconciliationExpiry.dom.test.tsx` | 44 |
| `src/components/composerDeliveryReconciliation.integration.test.ts` | 3 |
| `src/components/TmuxComposer.pendingImages.dom.test.tsx` | 1 |
| `src/components/conversation/OutboxBubbles.delivery.dom.test.tsx` | 19 |
| `src/lib/composerSubmissionPayloads.dom.test.ts` | 4 |
| `src/hooks/useRuntime.test.ts` | 22 |
| `src/components/TmuxComposer.deadHostComposerUsable.dom.test.tsx` | 13 |
| `src/components/TmuxComposer.inject.dom.test.tsx` | 76 |
| `src/components/composerAdmissionDeadline.test.ts` | 2 |
| `src/components/TmuxComposer.reconciliation.dom.test.tsx` | 10 |

The existing phone driver owns the rendered case:

```sh
LLV_SWIPE_BROWSER_TEST=1 bash scripts/gate-slot.sh bun test \
  src/components/mobile/issue1671Evidence.browser.test.tsx \
  -t 'delivery confirmation recovery'
```

Its server records one delivery in the runtime journal and delivery ledger,
appends the matching transcript echo, and then loses the POST answer. Recent
snapshots omit the receipt throughout. Original-key reads initially report
unknown; exposing the delivered record reconciles the bubble automatically.
The English dark frame holds an automatic read while Check is pressed; both
share that answer. The Ukrainian dark frame reloads before confirmation.
Each 390×844 frame keeps one message, one delivery, one send, the newer draft,
zero confirmation warnings and a document width of 390px. The committed
readings are `evidence/delivery-confirmation/phone.json`.

This is Chromium phone emulation in English and Ukrainian, light and dark.
Physical iPhone Edge lifecycle behavior and a real runtime-host or MCP-child
restart were not exercised. The original production trigger remains unproven,
as recorded in `docs/design/delivery-confirmation-lost.md`.
