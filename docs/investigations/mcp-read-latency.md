# MCP store-read latency

The reported 26–30 second production delay has **not been reproduced**. The
isolated host/lease harness is fast on both the base and the candidate. A
separate fault-injection test demonstrates synchronous caller projection
blocking unrelated calls in the same MCP process; the candidate removes that
unused work from availability checks. Production phase evidence is still
needed to attribute the original incident.

## Dispatch path

For `list_tasks`, `get_task`, and `get_pipeline`, the packaged stdio server runs
the SDK callback, `createMcpToolService`, and `viewerMcpBindings` in one process.
These bindings do not issue loopback HTTP requests. There is therefore no HTTP
route, route capability verification, or runtime-host snapshot in these three
read paths.

Before the change, `viewerMcpToolPolicy` synchronously built caller identity and
the authorized manager directory for every tool. Caller identity traverses
process ancestry and the stored registry's conversation/entry/receipt
projections, including the spawn capability digest and root identity. This is
a **registry** snapshot, distinct from a runtime-host socket snapshot.

The existing availability contract admits these reads for every agent identity,
including unidentified callers. Their policy now returns that same admission
without materializing unused identity projections. Archive/unarchive still
resolve caller and seat authority on every call. The admitted health-probe
credential still has its two-tool allowlist. Operation-specific identity checks
and caller-bound recoverable receipts remain in their bindings and recovery
path; no authentication result is cached.

After policy admission, the service claims its SQLite receipt keyed by tool and
request key. Distinct calls do not share an in-flight entry. A same-key duplicate
retains the existing replay/conflict behavior. SQLite claim and completion
transactions can wait for their own database writer; they do not hold a
transaction while awaiting the binding.

`list_tasks` uses the task selection source; an empty ID selection never loads
pipeline links. `get_task` reads one task and its selection-index links.
`get_pipeline` reads one active or archived pipeline row. These committed-state
reads do not acquire the pipeline mutation lease. On a cold process, collection
initialization can still take a short SQLite writer transaction; this is
distinct from the durable collection lease.

The service then journals the response and serializes the result for stdio.
The pipeline close binding still calls the engine directly and awaits its
mutation. Engine teardown and runtime-host implementation are unchanged.

## Controlled measurements

Base source: `34649607015fe5a1fbf29e0b243b6268d86c8d12`.
Tests use isolated state/config/provider homes, a private socket, and an
ephemeral HTTP port. No live state or listener participates.

| Experiment | Base | Candidate | Interpretation |
| --- | --- | --- | --- |
| Three parallel reads with 750 ms injected into each caller projection | 2,251 ms; four projections including the pending close | Under 1 ms; zero policy projections | Synchronous unused policy work serialized unrelated calls on their shared event loop |
| Packaged `list_tasks`, empty ID match | 20 ms | 34 ms | No dependency on the held pipeline lease or slow host |
| Packaged `get_task`, existing record | 20 ms | 34 ms | Same |
| Packaged `get_pipeline`, existing record | 21 ms | 35 ms | Same |

The packaged case starts two real close calls from the same MCP client while
another process holds the pipeline collection lease. A concurrent HTTP-backed
tool calls a fake runtime host whose snapshot reply takes 3,000 ms. All three
store reads finish before the lease is released or the host replies. Both
closes remain pending until release and then succeed. Exactly
one socket snapshot request belongs to the controlled HTTP call. The harness
also requires exactly one slow-call timing line from that call.

The injected projection delay isolates the synchronous policy boundary; it is
not a measurement of production registry cost. The host/lease comparison does
not establish a speedup. Neither experiment attributes the reported 26 seconds.

## Permanent timing

Calls lasting at least 2,000 ms emit one `[mcp slow]` line with the registered
tool name and numeric `callerMs`, `httpMs`, `claimMs`, `bindingMs`,
`completionMs`, `serializationMs`, `serviceTotalMs`, and `replayMs` fields.
Arguments, request keys, conversation identities, responses and error text are
excluded. Fast calls remain quiet. The existing numeric aggregates also expose
caller and HTTP phases.

Durations are wall time. `httpMs` is contained in `bindingMs`; an event-loop
stall from another call can inflate an awaited phase. For example, the injected
case gave the first read 750 ms in caller work and 1,500 ms in claim wall time
while the other two calls blocked the event loop. That does not mean its
receipt database was locked for 1,500 ms. Receipt-claim failures retain their
measured duration and emit a line even when the service throws.

## Validation limits

The new latency tests and service, binding, policy, manager-authority,
pipeline-busy-admission and original-key recovery checks pass. The service file
passes all 78 tests. `bunx tsc --noEmit`, `scripts/build-mcp.ts`, the production
build with `NODE_OPTIONS=--max-old-space-size=8192`, and the local privacy gate
each exit 0.

The complete stdio adapter file produces 15 passes and 16 failures on both
base and candidate, with the same failing test names. Send/spawn reservation
counts and terminal-evidence removal still use the legacy JSON registry after
the child has migrated it. An initial base run hit temporary-filesystem quota
exhaustion; the completed comparison uses a fresh isolated temporary root.

The remaining incident work is to capture these phase lines during an actual
26–30 second call and distinguish synchronous projection/CPU time, SQLite
writer contention, and downstream binding time. Slow-host correlation alone
does not select one of those causes.
