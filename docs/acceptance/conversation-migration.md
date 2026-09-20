# Conversation migration through Viewer

## Confirmed defect

Issue #1911 concerns the process that owns migration dispatch. At base
`a5d37a2d0ff7a943bb39e7ac6666e7450c4f9147`, the MCP binding calls
`applyConversationMigration` inside stdio. Structured dispatch requires the
Viewer's runtime connection, which stdio does not receive. The neighboring
conversation-action binding already uses Viewer HTTP.

The new routing regression failed on the original binding: zero HTTP requests
reached the injected Viewer. It passes after routing migration to the existing
`/api/conversations/:conversationId/migration` endpoint through the authenticated,
single-attempt control transport. No runtime socket is added to the MCP process.

## Account choice and receipts

- `reseat` retains automatic quota selection within the project's account pool.
- `select-account` requires `accountId` and uses the structured browser picker's
  validated reconfigure command, preserving the current model, effort and speed.
  A missing account or incompatible engine is refused; no fallback is selected.
- Browser semantics permit a deliberate choice outside the project's pool and
  attribute that choice. MCP uses the same semantics. Capability-derived actor
  identity survives HTTP; body-supplied role, project, engine and actor claims
  cannot replace the conversation's identity or the authenticated actor.
- Account fields on automatic reseat, and the unsupported `targetAccountId`
  alias, are refused explicitly. They can no longer disappear silently.
- `requestOperationId` identifies this command. A withdrawal's `operationId`
  continues to identify the earlier switch. The runtime receipt is preserved,
  including its queued status.
- A timeout after admission remains unknown. Replaying the same MCP key, even
  after an MCP restart, does not dispatch again. A later journal receipt is
  available through the bounded read below; the cached MCP timeout remains an
  accurate record of that call's unanswered transport.

## Bounded observation

`GET /api/conversations/:conversationId/migration?operationId=:operationId`
reads one conversation, its currently owned host's health and at most three
keyed journal receipts: the requested operation, reconfigure claim and migration.
It exposes active-turn references, claim epochs, hold presence, migration phase,
receipt status and timestamps. It omits message bodies, provider diagnostics,
account data, process endpoints and transcript paths. References use the existing
redactor and a length bound. The host read has a one-second observation bound.

The response distinguishes an absent control channel, an unavailable read, an
unowned local host, a missing receipt and a receipt for another conversation.
`controlChannel: configured` alone is not transport-health evidence. A successful
receipt read or host observation provides its own evidence. Reads do not drain,
retry, release a hold, refresh credentials or settle a delivery.

This endpoint supplies evidence for the original slow-switch investigation.
It does not establish that incident's gate. The earlier authentication failure,
the later held delivery and the MCP routing defect remain separate findings.

## Local verification

Run only these files, with isolated HOME, XDG, state, provider and temp roots,
and at least 8 GiB of freshly measured available memory:

```sh
bun test src/lib/mcp/conversationMigration.integration.test.ts \
  src/lib/mcp/bindings.test.ts src/lib/mcp/schemaParity.test.ts \
  'src/app/api/conversations/[conversationId]/migration/route.test.ts' \
  src/lib/runtime/structuredAccountIntent.test.ts \
  src/lib/runtime/structuredControls.test.ts
```

The integration fixture uses the actual MCP binding, bearer-authenticated HTTP
transport, production route handler, migration command, structured control,
runtime journal and delivery queue. The provider and account-existence lookup
are simulated. A simulated rebind records which account receives the send.
This proves routing, receipt identity and queue ordering; it does not prove a
provider successfully forks or authenticates on the selected account.

## Root-owned verification still required

1. Use an approved corrected Viewer build. Keep the current production release
   unchanged until a separate deployment decision. Confirm the build revision
   and the process serving its authenticated control endpoint.
2. The operator root admits one fresh, visible, task-bound cheap-model worker
   within the concurrency cap. Preserve the spawn key and its receipt. Wait for
   the initial response before selecting another known healthy test account.
3. Call `conversation_migration` with `action: select-account`, that worker's
   conversation ID, the selected account and a new stable request key. Read back
   the returned operation ID and bounded observation. The pick may remain queued
   until engagement; an active turn must continue on its original account.
4. Send one probe message with its own stable key. Observe the selected account
   before the single provider send, then the reply and delivery receipt. Repeat
   readbacks using the original identities. An uncertain result never permits
   a replacement key, replay of a revoked manager, or a second dispatch.
5. Return the disposable conversation to its original account through another
   explicit selection and one engagement. Record the account transition and
   delivery evidence. Stop only test processes admitted by this verification.
6. For a held switch, collect the bounded host/registry/claim/receipt projection
   before changing anything. Reproduce the observed gate in isolation before
   proposing a change to its runtime owner.

The account-store implementation in open PR #1902 remains a separate integration
dependency. This change uses existing registry/account APIs and does not alter
their storage or the provider. The separately reviewed UI change and unrelated
MCP response-compaction work are outside this patch.
