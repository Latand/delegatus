# Pinned Codex app-server boundary

Delegatus pins the generated app-server schemas for Codex 0.154.0, 0.159.0
and 0.162.1. The last is the installed CLI used to ground this change.
Each version has the CLI's stable and experimental bundles and their SHA-256
digests under `src/lib/accounts/protocol/`. The generated TypeScript closure
for the current server-request union and its response types sits alongside it.

Regenerate with the exact executable being reviewed:

```sh
bun scripts/generate-codex-protocol.ts --codex codex
```

The generator runs `--version`, `app-server generate-json-schema` both with
and without `--experimental`, and `generate-ts --experimental` for the current
router. Generated schema bundles are retained verbatim. A new supported version
also needs an explicit pin in `codexPinnedProtocol.ts` and a compatibility
review; installing a different CLI cannot silently change the adapter's wire
contract. An unpinned executable is refused before an app-server is spawned.

The boundary validates outgoing methods, fields and response decisions against
the selected pin. Schema errors name the CLI version, method and field path,
and omit payload values. The protocol test checks digests, methods and literal
request fields in the adapters, plus representative valid and invalid payloads
across the supported versions. Unknown notification methods and unmatched or
late response IDs are quarantined without terminating a healthy transport.
Wire IDs retain their string/number distinction.

Initialize offers one `experimentalApi` boolean in these schemas. Account
probes declare their stable methods; migration clients separately declare the
experimental `thread/resume.path` field; the structured host needs experimental
queue and realtime methods. The boundary records that declaration and rejects
fields absent from the selected schema or experimental fields on a stable
connection. There is no server-advertised general
method catalogue or selective experimental-method switch in this protocol.
The executable's `--version` selects the reviewed contract; `userAgent` has no
part in capability admission.

The host reads `model/list` and, when present, the read-only
`modelProvider/capabilities/read`. Its diagnostics retain the schema version
and digest, experimental declaration, per-model input modalities and the
provider's `webSearch` / `imageGeneration` receipt. Provider faults leave that
receipt unknown. The receipt is bounded to 4 KiB, and `modelsTruncated` records
omitted or shortened catalogue rows. The journal preserves this receipt across
runtime-host restarts. Image input is gated against the selected-model receipt
from thread start/resume and accepted model overrides. The protocol makes an
override apply to the current and subsequent turns. Steering inherits the
running turn's model; provider reroutes are scoped to their turn ID, including
those arriving before the turn-start reply. A completed turn's late reroute
cannot change a newer turn's image admission. Native queue support is confirmed
by its existing read-only list request; method refusals downgrade it.
After a queue method refusal, the host probes stable history separately with a
read-only `thread/turns/list`. An explicit method-not-found selects the legacy
reader; transport or permission faults keep canonical history fail-closed.
Injection has no read-only discovery method, so its pin admits the operation
and a real method-not-found response retires the capability.

## Approval router boundary and remaining work

This is the permitted first slice of #302. Exact method names classify
command, patch, permission, question, elicitation, dynamic-tool, auth,
attestation and time requests. Generated request and response types define the
handler interfaces. Every user answer passes the method's response codec before
stdin is written, including amendment decisions and multi-question answers.
Unsupported requests reject raw JSON answers. Restored approvals retain the
existing unowned state and cannot be answered by a new process generation.

The rest of #302 remains a separate delivery:

1. Bind the typed handler interfaces to full ingress parameter decoding and
   each attention action, including request-specific constraints such as the
   offered decision set, question IDs and permission scope.
2. Persist `threadId`, `turnId`, `itemId`, method, typed request ID and optional
   `approvalId` as the durable request identity. Persist answer dispatch and
   server resolution as separate receipts.
3. Reconnect to a surviving app-server, deduplicate replay by that durable
   identity, and restore the original attention ownership. A fresh process
   cannot inherit the previous process's callback just by reusing an RPC ID.
4. After process loss and `thread/resume`, record an explicit recovery outcome
   for each unresolved callback. Preserve uncertain deliveries honestly.
5. Cover server resolution before/after an answer, duplicate delivery,
   timeout, automatic resolution and late notifications with durable receipts
   and one terminal transition.

The present change preserves the existing restart behavior; it makes no claim
that those durable replay requirements are implemented.
