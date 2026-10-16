# Message delivery and the runtime-host connection

The 2026-10-16 delivery requirement sets two limits: a free recipient receives
an operator send within five seconds at p95, including two-second Viewer CPU
slices, and idle Viewer RPC p50 stays within twice the host handler p50.

The client shares a process-owned pool across route bundles. Each endpoint has
four command connections and sixteen long-poll connections, with at most 128
queued calls per pool. Sixteen endpoint/class pools can exist at once. A
single request deadline covers admission, connect and response. Idle sockets
expire after 15 seconds and are unreferenced. An error, abort, invalid frame or
id mismatch destroys its lease; the client never replays a mutation.

Client errors keep weak process-owned membership across route module copies.
A controller can recognize another bundle's transport error while ordinary
lookalike errors and coded domain refusals remain outside the cache fallback.

The listener acknowledges serial reuse only when the caller requests it.
Old clients receive one response followed by EOF. New clients also accept old
listeners that close each response. Each connection retains its error handler
before any write. Closing a listener closes idle leases and finishes its one
in-flight response before ending that connection. Preserialized snapshots keep
the byte-preserving response path under both protocol forms.

A delivery controller owns a cache of at most 32 effect pages and eight MiB of
conservatively estimated retained data. A conditional `effect-batch` reads the
journal generation, this connection's write count and SQLite's peer commit
version. An unchanged page returns that version without reading or transferring
the effect rows. A new journal generation, peer commit or local mutation
invalidates it. Old array readers retain their existing protocol.

A transport failure can reuse a validated page for up to 30 seconds. It schedules
another pass. Every operation still passes the existing durable status, delivery
record, host generation and dispatch checks before input. An unreadable status
refuses that operation. A cold cache, expired page, deterministic refusal or
unmatched conditional version remains an error. Cache bounds evict by age,
bytes and LRU order; a restarted controller starts cold. The queue still groups
active pending effects each pass. Reconfigure supersedence always reads the
live narrow effect list; a cached control never decides which configuration
is current. This change reduces repeated decoding and
wire data for unchanged pages.

A shorter wake replaces a later retry timer. A watchdog wake discovered while a
listing is in flight remains owed for its next pass. Fresh admission starts a
new pass immediately through an older listing's retry backoff; success resets
the failure budget. These paths retain the original operation and message key.
The loop monitor names RPC, delivery listing and delivery wake work.

## Shared protocol and write inventory

| Surface | Producers, consumers and defaults |
| --- | --- |
| Request `keepAlive` | `UnixRuntimeHostClient` requests reuse; direct socket callers omit it. `serveRuntimeHost` defaults to one response and EOF. Handler parameters and idempotency hashes are unchanged. |
| Response `keepAlive` | The listener acknowledges reuse; the client releases only acknowledged leases. Encoded snapshots, ordinary responses and domain refusals use the same connection lifetime. Mocks and old listeners omit the field and close. |
| Conditional effect page | The delivery controller calls `DeliveryEffectPages`, then optional `RuntimeHostClient.effectPage`. Recovery proxies forward cancellation. Old clients and the spawn, startup and reconfigure readers keep calling array `effectBatch`. |
| Effect page version | `RuntimeJournal` combines its generation and SQLite write witnesses. Admission, retry, operation transitions, native queue transitions, retention and direct outbox writes invalidate through SQLite; another connection invalidates through `data_version`. No schema or write format changes. |
| Wake ownership | Admission kicks, host state changes, retries and the watchdog reach the existing delivery controller. Each controller owns one wake timer; stop cancels it. Seat recipient authority and inbox composition stay with their existing owners. |

## Measurement procedure

`scripts/runtime-delivery-benchmark.ts` runs a separate runtime-host process with
an actual SQLite journal. The Viewer side calls the real HTTP send handler,
registry admission and bound delivery controller. A recording `EngineHost` is
the destination. It acknowledges each original operation exactly once; no
provider process is launched. Busy samples begin immediately before a two-second
CPU slice. The measurement includes ingress, admission, engine arrival and
queue confirmation. The recorded send time is an upper bound on time to the
engine; the destination ledger is checked before the final timestamp.

Both revisions run the identical driver and lockfile dependencies under Bun
1.4.0. Each has three repeats, 100 idle append RPCs and 20 sends in each load
mode per repeat. A separate listing sample retains exactly 200 pending effects
and runs three repeats of 30 unchanged passes. Each revision starts with fresh private state.
The report records UTC completion time and a SHA-256 of the exercised source.
The original isolated pilot was collected before product edits.

Run from a scratch export with private home, config, temp and state roots:

```sh
RUN_ROOT=$(mktemp -d "${TMPDIR:?}/delivery-benchmark.XXXXXX")
mkdir -p "$RUN_ROOT/home" "$RUN_ROOT/config" "$RUN_ROOT/tmp" "$RUN_ROOT/state"
HOME="$RUN_ROOT/home" XDG_CONFIG_HOME="$RUN_ROOT/config" \
TMPDIR="$RUN_ROOT/tmp" LLV_STATE_DIR="$RUN_ROOT/state" \
CODEX_HOME="$RUN_ROOT/home/.codex" CLAUDE_CONFIG_DIR="$RUN_ROOT/home/.claude" \
NODE_ENV=test LLV_STATE_OWNER= LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 \
bash scripts/gate-slot.sh bun scripts/runtime-delivery-benchmark.ts
```

Copy the same driver into a scratch export of baseline `93bbd3b547e4fb6b9b6a26a809e2462f7b5de486`.
The driver uses that revision's direct effect reader when its conditional cache
module is absent. Engine arrival measures the real handler and delivery path;
provider network latency and the browser-to-HTTP transport are outside this
experiment.

## Results

Measurements are recorded in `evidence/message-delivery-before.json` and
`evidence/message-delivery-after.json`. The table is generated from those files.

| Metric (repeats 1 / 2 / 3) | Before | After |
| --- | --- | --- |
| Idle send confirmation p95 (ms) | 44.217 / 46.604 / 50.708 | 52.714 / 38.456 / 43.350 |
| Two-second CPU slice: send confirmation p95 (ms) | 2063.092 / 2070.944 / 2050.664 | 2069.303 / 2052.605 / 2106.092 |
| Viewer append RPC p50 (ms) | 1.012 / 0.738 / 0.604 | 1.618 / 0.591 / 0.632 |
| Host append handler p50 (ms) | 0.577 / 0.469 / 0.409 | 0.977 / 0.418 / 0.481 |
| Viewer / handler p50 ratio | 1.753 / 1.575 / 1.478 | 1.656 / 1.414 / 1.314 |
| New sockets per 100 warm RPCs | 100 / 100 / 100 | 0 / 0 / 0 |
| Result payload bytes per 30 listing passes | 4,784,220 / 4,784,220 / 4,784,220 | 166,206 / 166,206 / 166,206 |
| Listing RPCs per 30 passes | 90 / 90 / 90 | 90 / 90 / 90 |
| Time for 30 listing passes (ms) | 88.097 / 90.809 / 86.465 | 19.538 / 15.371 / 17.291 |

All three after repeats meet both latency bounds. Result payload falls by 96.5%.
The listing pass time falls in every repeat. Total send time shows no
consistent improvement in this load; both revisions already meet the five-second
limit. The regression tests establish recovery from lost wakes and listing
failures separately.

## Verification

Checks ran through the project gate with private home, config, state and temp
roots, and the Viewer control URL on a closed endpoint:

- `bun test src/lib/runtime/structuredDeliveryController.test.ts src/lib/runtime/structuredDeliveryQueue.test.ts src/lib/runtime/structuredDeliveryQueue.progress.test.ts`: 163 passed.
- `bun test src/runtime-host/socket.test.ts src/lib/runtime/client.connection.test.ts src/lib/runtime/deliveryEffectPages.test.ts`: 23 passed, including cross-bundle transport refusal, cache races and live supersedence checks.
- `bun test src/lib/runtime/structuredDeliveryController.test.ts src/lib/runtime/deliveryWake.test.ts`: 7 passed.
- `bun test src/lib/runtime/client.test.ts src/lib/runtime/deliveryWake.test.ts src/lib/performanceSpans.test.ts`: 39 passed.
- `bun node_modules/typescript/bin/tsc --noEmit --incremental false`: passed.
- Scoped ESLint: zero errors; two existing unused-variable warnings in the controller.
- `bun scripts/verify-runtime-host.ts`: passed under Bun 1.4.0. The successor took over in 508 ms; listener and socket checks each answered 27/27 over 15 seconds.
- Publication privacy gate: passed on all changed source, tests, measurements and this report.

The lost-wake regression is red on the baseline: a send admitted during an older
listing has no engine input after that pass ends. The fixed queue delivers the
original operation in its immediate rerun. Existing client and controller tests
also pass on the baseline with the same isolation. The separately bundled
client failure control is red on the baseline and green on the final source. The percentile fixture uses
a clock advanced by receipt of each request, so instrumentation can read the
clock freely.
