# Recovering an interrupted internal MCP request

Keep the original tool, arguments and `clientRequestId`. For `send_message`,
repeat those arguments with `recoveryOnly: true`. Recovery checks the existing
delivery record first. When no delivery exists, it asks the Viewer about the
transport request ID derived from the original receipt binding.

An `http-ingress-fence` result proves that this attempt cannot execute: the
Viewer atomically reserved its absent ID as fenced, and every later arrival
with that ID is refused before route invocation. The returned nonexecution
disposition permits a fresh send. A received request is recovered from its
delivery record or retained HTTP response. An active request with no readable
outcome remains unknown; keep its key and look it up again.
The live reply and retained response share the send acceptance validator;
malformed verdicts stay unknown and extra response fields remain private.

A peer that leaves while ingress admission is awaiting its writer is fenced
under the admission's own nonce before any route is invoked. A stale completion
or abandonment cannot overwrite another admission's outcome.

Historical requests sent before this protocol have no transport evidence.
An expired, evicted, malformed or pre-coverage ID cannot establish
nonexecution. Neither can a failed journal lookup. This change does not settle
historical production incidents retroactively or establish their closing peer.

## Transport and evidence

Every internal HTTP producer in the MCP adapter, startup verification and
Viewer bindings uses `controlFetch`. It sends `x-delegatus-mcp-request` and
uses a fresh connection to the configured HTTP(S) control endpoint. The stdio
adapter and startup retain their existing loopback HTTP restriction.
There is no pooled keep-alive socket
or separate idle timeout. Binding requests use a 15-second attempt bound and
at most a 30-second recovery budget, shortened by the explicit caller deadline.
Evidence lookups also allow 15 seconds, within the caller's remaining budget.
The client requests identity encoding and retains gzip, deflate and Brotli
decoding for peers that return encoded responses.
Startup retains its ten-second discovery deadline. Attention reads retain
their earlier route-level budget for partial answers.

Viewer instrumentation installs the ingress observer on the serving native
Node HTTP server before readiness. It verifies the existing signed internal
`mcp` service marker. Before invoking Next or any route policy, it awaits
durable admission for that ID. Ordinary callers keep their existing route
authorization. The internal recovery endpoint requires that same verified
service marker and returns only request-specific evidence.

The server records ingress, response status, response completion, socket close
and socket errors. The client records start, response, socket error and close,
with byte counters, a bounded error code and method/path without query strings.
Counters describe the socket lifetime; the shipped client opens one connection
per request. An abort retains its abort code and does not establish which peer
caused an earlier production reset.

Evidence lives in `mcp-http-server.sqlite` and `mcp-http-client.sqlite` beneath
the selected state directory. Files are private. Each database retains at
most 2,048 request rows and 2,048 transport events, with a 24-hour age bound
applied on the next operation. JSON response capture is limited to 16 KiB;
larger or compressed bodies stream normally and require downstream receipt recovery.
No request body, authorization header or query string enters the transport
event log. Small JSON outcomes remain private local recovery data.

SQLite work, including fsync, runs in a worker with a queue bounded to 256
pending operations. Its 15-second acknowledgement deadline exceeds the
observed loop gaps. Failure closes its pending calls and refuses further work
from that writer; a Viewer restart reopens the durable evidence. Client
diagnostics are best effort and have a separate bounded queue. A missing
client event never proves nonexecution. No latency improvement is claimed.

Eviction advances a durable proof floor before deleting any request rows.
A newly opened or replaced database advances its absence coverage boundary;
retained ingress and fence witnesses remain readable across restart.
Recovery therefore cannot interpret retention or a restored older file as
proof of absence. A busy or unavailable ingress journal refuses the request
before its handler runs; other HTTP callers can still progress.

## Verification

`src/lib/mcp/controlEvidence.test.ts` exercises durable fences, process
reopening, retention, capacity, failed writes and database replacement.
`src/lib/mcp/controlTransport.http.test.ts` drives a real SDK client through
the exported MCP route, policy, service, SQLite receipts, production bindings
and internal HTTP transport on ephemeral loopback ports. It checks a socket
cut before ingress, a cut after response completion, refusal of delayed bytes,
safe resend, response bounds and an independently stalled serving process.
