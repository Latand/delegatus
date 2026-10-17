# Curator admission and liveness history projections

Curator recovery, curator attempt counts, liveness lineage and fleet limit waits
now use keyed registry reads and persisted SQLite projections. This removes
repeated materialization of retained pipeline bodies from Viewer requests.

## Read and write boundaries

`AgentRegistry.curatorConversationSnapshot` resolves one canonical conversation,
its aliases, role evidence and matching launch receipts. Recovery admission and
both MCP curator authorization checks use it. The read binding checks authority
again after awaiting history preparation. The JSON registry adapter retains its
existing compatibility behavior.

SQLite insert, update and delete triggers coalesce changed identities in
`history_pending`. The triggers cover pipeline saves, bounded patches, controller
writes, archive moves, flow saves, imports and older/raw SQL writers. Projection
refresh reads one changed record per transaction and yields between records after
four milliseconds of accumulated work. Its final transaction checks the relevant
collections' queue before reading their projections. Failed work rolls back with
its pending identity intact. Release authority is checked before and inside each
write transaction, including before commit.

The persisted tables contain project/state headers, stage roles, attempt identity,
state, timestamps and provider waits, plus the four headless reviewer ownership
fields used by liveness. Liveness resolves lineage by conversation/path indexes;
fleet resolves waits from the bounded answer's conversation IDs. The count reader
uses the project index. Explicit join ordering keeps singleton and multi-value
selectors scoped to these indexes.

Pipeline and archive records contribute to curator counts. Counts retain the
inclusive 30-day window, future/invalid timestamp handling, effective-role
fallbacks and zero-count stage roles. Lineage retains collection order, run/attempt
order, historical-attempt exclusion and conversation-before-path precedence.
Project aliases invalidate count reuse, including a caller carrying an earlier
project key.

## Ownership, limits and startup

One `globalThis` owner shared by compiled Next bundles holds an LRU of at most
64 count results, charging at most 256 KiB of serialized UTF-16 keys, stamps and
results, and at most two database connections. Eviction drops the oldest count
result or closes the oldest connection. A count result expires on project
revision, database identity/generation, alias membership, clock reversal or the
next attempt-window boundary. Persisted projection rows follow their source
identities; deletion/rebinding removes their derived rows. Empty project headers
are removed, while the database clock prevents revision reuse after recreation.

Viewer hot-state initialization prepares the persisted artifact before completing
activation. Refreshes use `waitForStateLock`, cancellation and a single deadline;
the ordinary preparation ceiling is 30 seconds. Liveness passes its remaining
answer deadline to refresh. An already prepared artifact can answer without a
refresh budget. Each reader prepares its needed collections. An unrelated
archive failure therefore leaves active liveness readable.

Loop attribution uses `history.prepare`, `history.project-row`, `history.read`
and `memory.curation-admission`. The synchronous source adapters remain available
to full-record consumers; liveness uses their specialized `forLiveness` readers.

## Measurements

Final repeated measurements and source digests are recorded in
[`evidence/history-projection.json`](../../evidence/history-projection.json).

| Operation | Phase | Before main-thread ms | After main-thread ms | Before bytes read | After bytes read |
| --- | --- | ---: | ---: | ---: | ---: |
| History reads | cold | 1605.028 | 2243.476 | 160,411,190 | 338,558,442 |
| History reads | warm | 1318.085 | 0.370 | 159,863,157 | 165 |
| Registry admission | cold | 954.819 | 9.001 | 783,881,678 | 176,386 |
| Registry admission | warm | 0.000 | 2.000 | 154 | 4,280 |

Values are medians. The history corpus has 1,153 records and 153,203,262 JSON bytes; the registry has 52,207 rows and 187,103,963 JSON bytes. Result counts agree in every repetition (4,113 history attempts; one selected registry conversation).

Cold projection preparation has a median elapsed time of 3053.0 ms and a maximum observed timer gap of 16.5 ms. Warm history calls have a median elapsed time of 0.783 ms and a maximum observed timer gap of 1.340 ms. Cold preparation is paid during Viewer startup.

The procedure uses byte-identical private SQLite backups for each mode and fresh
process. Three process pairs per operation each perform one cold call and three
warm calls. The history operation exercises the old pipeline/archive/flow loads
and curator counting loop, then their narrow count, lineage and headless-owner
readers. The admission operation compares the registry snapshot with one keyed
conversation snapshot. All corresponding result counts must agree.

`readBytes` is the Linux main thread's `rchar` delta, including the small counter
read overhead. `mainThreadMs` comes from that thread's scheduler run counter;
short calls can fall below its update resolution. A 10 ms timer observes recovery
after each measured call. Initial schema installation, target selection and
corpus sizing precede the measured calls. Cold projection preparation is recorded
separately from warm request cost. These are isolated function-seam measurements.

Commands, run sequentially under the installed `scripts/gate-slot.sh` wrapper,
with private `HOME`, `XDG_CONFIG_HOME`, `LLV_STATE_DIR` and `TMPDIR`:

```sh
bun scripts/measure-history-projection.ts --isolated-copy --legacy
bun scripts/measure-history-projection.ts --isolated-copy
bun scripts/measure-history-projection.ts --isolated-copy --admission --legacy
bun scripts/measure-history-projection.ts --isolated-copy --admission
```

Each command receives its own database backup through `LLV_STATE_DIR`.

## Verification

The full touched-test gate completed 32 explicit files against `e4a86ff27da4` with zero new failures. It recorded 9 failures reproduced on the base and 1 intermittent assertions under its confirmation rules. Branch and baseline runs took 89.560 s and 17.415 s respectively. Typecheck and changed-file ESLint passed. Exact known outcomes are in the evidence JSON.

The hook's `discover` and `plan` functions select every touched and adjacent test.
The recorded gate adds the startup, legacy-import and fleet-binding integration
files explicitly. Each file runs under the hook's own fresh HOME/config/state/temp
isolation. The evidence records the exact path list, base revision and comparison
outcomes. The project typecheck includes every touched test.

Coverage includes empty and large history, window boundaries, role overrides,
legacy property-name behavior, archive moves, raw peer changes, deletion/rebinding,
cache byte/count eviction, duplicate module loading, a real process restart,
query plans, cancellation, deadline expiry, release fencing during a yield,
project succession and curator authority revoked during an asynchronous read.
