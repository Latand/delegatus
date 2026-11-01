# Mid-turn recipient acknowledgement

## Incident, 2026-10-29

A cross-project seat relay was accepted at 10:22:11.492Z. The source seat's
`send_message_to_orchestrator` result returned the destination seat, its existing
conversation, the operation handle and `outcome: queued` at 10:22:12.063Z.
A later `message_receipt` read reported `state: failed`, `duplicateRisk: true`
and `resend: verify-first`, with a confirmation-timeout reason.

The receipt's phase history records dispatch at 10:22:16.050Z, uncertainty at
10:22:46.736Z and an engine echo at 10:23:06.065Z. The destination's transcript
record 1184 is a prompt-mode `queued_command` attachment, timestamped
10:22:16.633Z. Its `source_uuid` agrees with the inferred acknowledgement
persisted in host delivery-ledger record 44 at 10:23:06.067Z. Transcript record
1185 removes that command with reason `absorbed_mid_turn` at 10:23:06.035Z;
record 1186 contains the system message supplied to the running turn. Subsequent
records create the requested work and reply to the source seat. The transcript
and delivery ledger establish receipt independently of the later reply.
The queued ledger record was written at 10:22:16.612Z. Its 950-character payload
matches the recipient attachment's prompt exactly.

The feed already normalizes this attachment using `claudeQueuedPromptUser`
(`src/lib/claudeProtocolUser.ts:119`, introduced by the mid-turn feed fix).
Delivery confirmation instead reads `readClaudeTranscriptUsers` in
`src/lib/runtime/claudeStreamBrokerHost.ts:633`. Its original filter accepted
only `type: user` records. `confirmedSend` in
`src/lib/runtime/confirmedSend.ts:47` therefore could not validate the inferred
UUID against the recipient transcript. The late acknowledgement remained
unverified even though the feed could render the message.

## Contract and scope

The transcript reader uses the existing queued-prompt normalizer. Content comes
from `attachment.prompt`, and identity from `attachment.source_uuid`; the outer
attachment UUID and the reminder in `rendered` supply no delivery proof.
Copies sharing an engine UUID, text and number of images count once, including
an attachment followed by an ordinary user record with transcoded image bytes. Task notifications remain
outside this contract. Existing content, time,
UUID-allocation and batch-membership checks still decide confirmation.

Production paths and their records:

- The structured send and inbox composer normalize queue entries and persist
  their content digests. The Claude host writes queued entries and later
  inferred stream echoes to `FileClaudeDeliveryLedger`.
- Transcript adoption and `confirmedSend` share `readClaudeTranscriptUsers`.
  Confirmation binds one recipient UUID to one queue entry. Inbox members also
  require `verifyBatchMembership` against the real composed batch.
- `resolveSendReceipt` arbitrates positive evidence with the runtime journal
  before correcting the registry and delivery progress. Discard and migration
  cancellation retain their existing fences.
- The retry endpoint in `src/lib/runtime/http.ts:847` checks recipient evidence
  before authorizing another attempt. Confirmed delivery returns the original
  operation's delivered receipt without rearming or waking delivery.
- Codex uses its existing structured-user encoder, operation dedup token and
  rollout reader. Its mid-turn user record follows the same settlement path.
- The composer consumes the existing receipt status; no field or UI change is
  required. Failed unknown-fate receipts retain their retry path until evidence
  confirms receipt.

No state schema, write contract, delivery policy or publication behaviour changes.
This fix claims no performance improvement.
