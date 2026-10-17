# Receipt reads under HTTP rendering

The receipt lookup introduced with #3004 used a multi-value `IN` followed by
collection ordering. SQLite chose `registry_archive_order (collection=?)`,
reading retained receipt bodies to test the predicate. The duplicate
`[canonicalId, conversationId]` supplied by liveness was enough to trigger it.
The fleet's list of distinct canonical ids triggered the same plan.

The selector now deduplicates values, runs one field-index selection per value,
and merges matching keys by their stored collection order. The archive identity
join, pending mutations, held snapshots and receipt interfaces stay intact.
There is no new cache, migration, schema or receipt writer.

## HTTP consumers

These shared receipt-bearing paths are replayed individually:

| Consumer | Selection |
| --- | --- |
| `POST /api/mcp`: `agent_activity` | Liveness conversation ids and transcript path |
| `POST /api/mcp`: `agent_fleet` | Liveness plus a fleet canonical-id list |
| `POST /api/mcp`: `get_orchestrator` | Seat conversation liveness |
| `POST /api/mcp`: closing `update_task` | Conversation liveness |
| `POST /api/attention/needs-you` | Liveness ids and transcript path |
| `GET /api/orchestrator/seat/status` | Seat conversation liveness |

The regression tests call the production `agentLivenessSnapshot` and
`fleetRuntimeFor` functions with injected inventory, clock and process evidence.
They inspect `EXPLAIN QUERY PLAN` for the exact SQL and bindings executed by the
store. They reject collection-only searches as well as scans. These are shared
call-path tests; transport, authorization and unrelated route work are excluded.
Historical production rates for individual routes remain unavailable because
the retained diagnostics deliberately omit route names and SQL bindings.

## Repeated replay

Bun 1.4.0; 32,769 synthetic receipts, 32,768 archived and one current;
132,366,336-byte SQLite input. Every pass opens a byte-identical private copy.
Both versions replay the six consumers in the table once, in table order, with
fresh snapshot reads per request. Index preparation and initial snapshot
initialization precede measurement. One matching receipt is returned, and the
fleet also requests one absent canonical id. No live database is used.

The observer measures Linux main-thread `rchar` around each receipt-selector
statement, subtracting its own procfs read. It measures synchronous selector
wall time separately; query-plan inspection is outside that time. These are
logical reads through SQLite, including OS page-cache hits. A warm SQLite page
cache can produce zero kernel reads. Payload decoding, snapshot startup and
other store reads are outside the selector totals.

| Pass | Before bytes / cycle | After bytes / cycle | Before sync ms / cycle | After sync ms / cycle | Before max query ms | After max query ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 638,013,440 | 36,864 | 1159.701 | 0.212 | 173.188 | 0.059 |
| 2 | 638,013,440 | 36,864 | 738.400 | 0.125 | 116.427 | 0.029 |
| 3 | 638,013,440 | 36,864 | 674.787 | 0.118 | 100.114 | 0.036 |

Each cycle contains six requests. The baseline uses 13 receipt-selector
statements per cycle; the fix uses 14, as the fleet's two distinct values get
separate seeks. Ordinary liveness requests read 91,148,288 bytes before; the
fleet reads 182,272,000. Afterward the first request reads 36,864 bytes per pass;
the remaining requests hit SQLite's cache. Every measured fixed selector is
below the 50 ms target. At 2,771 repetitions of the largest fixed request, this
synthetic workload would read at most 102,150,144 bytes in a 30-minute window,
below the 13.6 GB reference. This projection applies to the recorded workload;
a production window after deployment remains a separate observation.

Full per-request numbers and query plans are in
[`evidence/receipt-read-replay.json`](../../evidence/receipt-read-replay.json),
including the input digest, base revision and final selector source digest.
The improvement comes from field-index searches in both receipt collections.

Reproduce from a scratch export containing the harness and dependencies, with
private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`,
`LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1` and `LLV_STAGING=1` (so inbox data also
stays inside the private state directory). Run each command through the
project's `scripts/gate-slot.sh`, one at a time:

```sh
bun scripts/receipt-read-benchmark.ts --seed "$TMPDIR/receipts.sqlite" --count 32769
bun scripts/receipt-read-benchmark.ts --database "$TMPDIR/receipts.sqlite" --count 32769 --repeats 3
```

For the baseline, keep the final harness and replace only
`src/lib/agent/sqliteRegistryStore.ts` in that scratch export with its version
at the evidence's `baseRevision`. Restore the final selector for the second
run. Keep the seed unchanged. The evidence records all three independent
connection lifetimes for each version.

## Serving revision

The launcher now passes `LLV_DIAGNOSTIC_REVISION` from each selected child
release to both the Viewer and runtime host on every launch and replacement.
This value is diagnostic metadata; it grants no state-write or release
ownership. Gap and summary records use it when process release identity is
unavailable, before falling back to hot-state authority. An invalid or absent
revision clears inherited child metadata; a truly unknown revision stays null.
The serialized-output tests cover both process roles, precedence, malformed
values and startup before hot-state activation.

## Regression verification

With the final regression tests and fixtures on the base source, 37 tests pass
and 13 fail: both multi-value plans, all six consumer call paths, the absent
selection plan, and four revision cases. With the fix, all 224 tests in the
receipt-read, monitor, launcher-environment, lifecycle-liveness and fleet test
files pass. The launcher-environment test additionally starts real children to
verify the selected revision and removal of an inherited predecessor value.
TypeScript, changed-file lint and the known-value privacy gate pass in isolated
state. Hosted checks run after the publication step creates the pull request.
