These nine `claimed_*.json` bodies were built by the relay service's own
requester, input and claim functions and validated against its JSON Schema
at service revision `60e3becf`. They cover four roles, a claim without the
feature, memory at 16,000 code points, emoji media at 12,000 code points,
emoji memory at 16,000 code points, and the claim byte budget.

The catalog names and summaries have been replaced with synthetic values
for publication. Field shapes, role flags, tool counts, opaque test keys and
message and memory lengths are preserved. The source used invented platform
identifiers; no live request was captured.

`protocol.test.ts` parses every body through `requestSchema`. `runner.test.ts`
runs the four roles with a fake service and emits `install_completions.json`
when `LLV_RELAY_WIRE_OUTPUT` names an output file. The output captures the
real hand-off and member-limit completion bodies and the poller's claim body,
for validation against the service's Completion and ClaimRequest schemas.
The committed `evidence/external-relay/install_completions.json` is that
emitted output; the runner test compares its stable fields with the actual
bodies, while checking the clock-dependent retry duration separately.
