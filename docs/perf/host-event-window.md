# Host event window byte budget

Each structured host retains at most 2048 events and 6 MiB of serialized UTF-8
event bytes. `LLV_HOST_EVENT_WINDOW_BYTES` chooses a positive integer byte budget
for newly constructed hosts; invalid values use the default. Byte sizes are
computed once as events enter the window and subtracted on eviction. Diagnostic
reads use scalar counters. These counters measure serialized event payloads;
JavaScript object overhead, subscriber queues and the bounded ledger cache have
separate owners and are outside this budget.

Large command output, file bodies, patches and tool inputs/results retain a
4096-byte UTF-8 prefix plus an explicit marker with the original string's byte
size and a pointer to the full transcript. Only the in-memory item payload is
copied. Producers append the full event to their durable ledger first, and live
subscribers continue to receive that full event. An event that still exceeds the
budget evicts the prefix including itself, keeping a contiguous window; replay
then reads it from the ledger.

## Readers

- `attachRuntimeEvents` replays retained previews and reads older events from the
  full ledger. An empty window also reads the ledger and checks its replay gap.
- `structuredDeliveryController` projects replayed items through
  `projectEngineHostEvent`, then the journal and the conversation live-turn
  projection. Tool identities, failure flags and completion states survive.
- Claude delivery matching happens before previewing. Its replay keeps exact
  user text, content digests and `deliveryEcho` metadata. Codex native queue
  proofs keep complete `userMessage` items, client ids and canonical identity.
- Codex adoption reconciles replay keys, buffered notifications, tool results,
  callback receipts and voice state against full history before releasing it to
  the bounded window. The live Viewer MCP observer also runs before previewing.
- The permission guard consumes unchanged attention events. The native subagent
  observer consumes unchanged item identities and activity evidence. Realtime
  context consumes unchanged user/assistant messages and deltas; turn-boundary
  readers keep their existing separate bounded memory.
- Copilot ACP tool updates use the same budget and preserve terminal outcomes.

`/api/operator/heap` exposes `attribution.hosts.windowBytes`,
`largestWindowBytes` and `trimmedEvents`, both overall and per engine. Detailed
host rows also expose `windowByteLimit`. The compact snapshots saved by the
existing series sampler retain the same totals and maximum without host rows.
`trimmedEvents` counts previews currently retained, decreasing when they leave
the window. Byte totals exclude ledger fallback and subscriber queues.

## Reproduction

`src/lib/runtime/hostEventWindow.test.ts` records 2500 deterministic command
completion events with 20 KiB output each, which fit the old 2560-event count
ceiling. Three independent windows consume identical serialized records. Each
run asserts exact retained bytes, a contiguous suffix, matching preview counts
and the 6 MiB budget, and prints the before/after measurements. The producer
tests cover real host startup, durable writes and replay; the Codex test also
adopts the ledger and checks that reconciliation adds no duplicate tool item.

The serving-process heap at roughly forty live hosts remains a post-deployment
measurement. The byte counters make that measurement attributable without
walking or serializing event windows in the diagnostics endpoint. No listener
or socket-write error handling changes are involved.
