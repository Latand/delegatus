# Pinned Codex app-server boundary

Delegatus pins the generated app-server schemas for Codex 0.154.0, 0.159.0,
0.162.1 and 0.163.0. Each version has the CLI's stable and experimental
bundles and their SHA-256 digests under `src/lib/accounts/protocol/`. The
generated TypeScript closure for the server-request union and its response
types sits beside 0.162.1; the 0.163.0 closure is byte-identical, so the
router keeps importing it from there.

Regenerate with the exact executable being reviewed:

```sh
bun scripts/generate-codex-protocol.ts --codex codex
```

The generator runs `--version`, `app-server generate-json-schema` both with
and without `--experimental`, and `generate-ts --experimental` for the current
router. Generated schema bundles are retained verbatim. A new supported version
also needs an explicit pin in `codexPinnedProtocol.ts` and a compatibility
review; installing a different CLI cannot silently change the adapter's wire
contract.

## CI coverage

Installed CLI pin: `0.162.1`.

Verified with `codex --version` on 2026-10-20. The shared
`native-codex-versions` YAML anchor in `.github/workflows/bun-runtime.yml`
declares the versions for the native runtime job, the manual queue campaign
and the local pre-push native phase. It includes the oldest supported CLI
and every generated host pin. `scripts/bun-runtime-workflow.test.ts` fails
when this installed pin is absent from the matrix or the matrix differs from
the host pins under `src/lib/accounts/protocol/`. Update this line when the
installed pin changes and update the shared matrix in the same change.

The native steering fixture disables `instant_interrupt` only for its
`dropped-after` case, keeping accepted input pending until its explicit
interrupt. Codex 0.162.1 enables sampling preemption by default and can record
that input before the interrupt arrives. The sampling and busy-tool cases keep
the CLI defaults and verify delivery without a second submission.

## An executable without its own pin

The Codex CLI updates itself. On 2026-10-16 an update to 0.163.0 made every
Codex stage refuse at launch until the CLI was pinned back, although that
schema only added to 0.162.1. An unpinned executable is now compared before an
app-server is spawned (`resolveCodexProtocol` in `codexPinnedProtocol.ts`):

1. The pin it is compared with is the newest pin older than the CLI. A CLI
   older than every pin, or a version that does not parse, is refused.
2. The executable generates its own stable and experimental bundles
   asynchronously, into a temporary directory that is removed afterwards.
3. `codexSchemaBreaks` (`codexSchemaCompatibility.ts`) checks that both
   bundles extend the pin additively. Allowed: new definitions, new optional
   properties, new enum values and new union variants. A removed definition,
   property, enum value or variant, a property that became required or
   optional, a changed type, reference or default, and a new server-request
   method all count as breaks. A new server request is refused because Codex
   can hold a turn on a request the adapter was never reviewed to answer.
   For the same reason the server-request union and every definition its
   params reach must stay unchanged apart from descriptions and titles: the
   host decodes each incoming request strictly against the pin, so an added
   optional field, enum value or variant there would make an existing
   approval, question, elicitation or tool call unanswerable. 0.159.0 changed
   that closure (`McpServerElicitationRequestParams`); 0.163.0 left it intact.
4. An additive CLI runs under the pin. Every payload is still validated
   against the reviewed schema, so a method or field that only the newer CLI
   has stays unusable until it is pinned. Errors name both versions
   (`CLI 0.163.4 (under pin 0.163.0)`). The registry keeps the pin as the
   host's protocol version, so a successor reconnects under the same contract,
   and older releases can still read the record. The runtime diagnostics
   report the CLI's own version, and the protocol receipt carries
   `unpinnedCli` with the CLI version and the digest of its generated
   experimental bundle. The admission is also logged once with a
   `[codex protocol]` prefix.
5. A break refuses the launch. The message gives the remedy (pin the CLI to a
   supported version, or regenerate and review), the supported versions and
   the first three breaking paths. It names paths only and never schema values.

Verdicts are cached per CLI version for the life of the process, with at most
eight entries and the oldest evicted. Concurrent launches share one
generation. A failed or timed-out generation (30 seconds for each of the
stable and experimental runs, so at most 60 seconds) refuses that launch
and is not cached, so the next launch tries again. The bound does not depend
on the child: each run leads its own process group, and at the deadline the
whole group is sent SIGKILL and the run is refused without waiting for it to
exit, so a CLI that ignores SIGTERM cannot hold the shared admission. Generation runs under the
`codex.protocol-admission` loop-monitor label. Against the real 0.163.0 and
0.162.1 executables (posing as 0.163.9 and 0.161.0), one admission took
121–136 ms, and the longest event-loop stall during it, sampled by a 1 ms
timer, was 9 ms.

The fallback does not replace review. It keeps lanes running across an
additive update, and it never widens the contract the adapter writes.

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

## Durable approvals and questions

The host validates every server request against the selected schema before it
exposes answer controls. Answers also pass the response schema and the request's
constraints: offered command decisions and amendments, exact question IDs and
option labels, and permission grants within the requested paths and network
capabilities. Questions retain their custom-answer and secret-input flags.
Malformed or unsupported requests remain visible with their answer controls
unavailable.

The host ledger retains complete requests. Journal projections carry a request
digest and indexed selections instead of copying full option labels, permission
scopes or policy amendments into answer controls. The callback owner expands
each selection against that request before validating and dispatching the native
response. Display text is clipped; the response retains every selected value.
Dispatch receipts retain both the native response digest and, when used, the
selection digest so confirmed retries survive journal and host recovery.
If the question or action structure itself exceeds the projection budget,
the operator sees a pending callback with answer controls unavailable; an
incomplete set of controls cannot submit a partial answer. Later host events
continue through the journal.

A request receipt retains the process generation, thread, turn, item, method,
typed RPC ID and optional approval ID. String and numeric IDs remain distinct.
The attention ID incorporates that identity, so concurrent processes using the
same RPC ID cannot collide in the shared journal.
The request digest detects a conflicting replay. Answer dispatch is fsynced to
the event ledger before the response is written. A separate server-resolution
receipt closes the attention. A concurrent identical answer joins its existing
waiter; a different answer is refused. A confirmed identical retry returns the
existing result. Automatic server resolution never manufactures an answer
receipt, and a late replay cannot reopen a terminal attention.

On every reviewed pin, Unix hosts launch the app-server with its native private Unix
WebSocket listener. Its socket directory lives under the Viewer's home, which
is shared with host CLI processes in the container installation. Directory and
socket permissions, UID, PID, kernel start token and boot epoch are checked
before and after connection. Codex 0.162.1's advertised symlink is resolved to
its digest-named socket in the recorded process's mount namespace; the target
directory and socket receive the same permission and owner checks. A successor
uses the process's retained protocol pin and claims the exact recorded listener
only after the previous writer has relinquished ownership or is proven gone.
A normal Viewer demotion drops the connection while keeping the app-server;
startup also reconnects after a hard Viewer exit. It preserves the surviving
process's MCP credential and thread policy. A failed reconnect handshake closes
its connection and releases the writer claim, keeping the original process
available for another attempt. `thread/resume` replays pending
callbacks, restoring their original attention identity. Reusing an RPC ID in a
new process does not transfer callback ownership.

Windows retains its stdio transport. A runtime
host restart keeps a surviving Viewer's callback owner; replacing a stdio
app-server ends its callbacks. Requests retained from an older release have the
same limitation. The operator sees `callback-unavailable` for an unresolved
request whose callback cannot be recovered. An answer with a dispatch receipt
and no server-resolution receipt is `delivery-uncertain`, including after a
process dies or a timeout expires. It is never dispatched again. A subsequent
resolution notification from the verified original generation can still close
that attention. Replayed dispatches without resolution receipts immediately
retain a durable uncertainty outcome, including when replay precedes the
resume reply. These outcomes retain the original request and its receipts.

The event ledger and runtime journal have separate restart regressions. The
process fixtures kill a Viewer with a pending request and after an answer has
been consumed, then reopen the same durable ledger. Native transport coverage
uses an isolated Codex app-server and a credential-free local Responses fixture
to verify callback replay and resolution. The shared browser driver covers
permission scopes, custom questions and recovery messages at phone and desktop
widths in both interface languages.
