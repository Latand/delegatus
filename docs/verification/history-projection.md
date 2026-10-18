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
fields used by liveness. Count-role totals are maintained per project as each
source row is projected, so an LRU miss does not regroup every retained run.
Headless-flow changes carry a monotonic per-row journal; a warm owner projection
replaces only changed flow rows and reloads fully after eviction or a journal
gap. Confirmed-dead rounds leave the active-owner walk and remain in the bounded
projection as path/conversation-indexed evidence for targeted result assembly.
An unrelated flow update does not restore those rounds to the active walk.
Liveness resolves lineage by conversation/path indexes; fleet resolves waits
from the bounded answer's conversation IDs. The count reader
uses a count-specific per-project revision and an index over normalized attempt
timestamps, so lineage-only updates keep warmed counts and time-window reads
exclude expired history. Explicit join ordering keeps singleton and multi-value
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
results, a headless-flow LRU of at most two entries and 16 MiB total, and at most
two database connections. Eviction drops the oldest count or headless result or
closes the oldest connection. A count result expires on count-affecting
project revision, database identity/generation, alias membership, clock reversal
or the next attempt-window boundary. Confirmed dead process identities stay
memoized in an 8,192-entry bound, while live and unproven identities are
rechecked after one second. Dead rounds remain in liveness evidence through host
assembly. Persisted projection rows follow their source
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
| History reads | cold request | 1194.258 | 16.040 | 163,151,766 | 6,156,294 |
| History reads | warm request | 1144.343 | 0.000 | 162,579,226 | 156 |
| Registry admission | cold | 809.206 | 5.999 | 805,797,339 | 176,388 |
| Registry admission | warm | 0.000 | 1.350 | 152 | 4,280 |

Values are medians over three fresh process pairs; the history request also has three warm calls per process. Scheduler-counter values below its update resolution can read as zero. The history corpus has 1,171 records and 155,853,818 JSON bytes; the registry has 53,270 rows and 191,385,527 JSON bytes. Result counts agree in every repetition (4,113 history attempts; one selected registry conversation). Projection startup preparation is measured separately: median 5,191 ms elapsed, 4,138 ms main-thread time and 502,884,811 bytes read. Preparation reads and writes the persisted projection cooperatively before serving.

### Refresh and liveness follow-up

On 2026-10-18, three fresh before/after process pairs used copies of the same
page-streamed SQLite backups (hashes and raw samples are in the evidence JSON).
The source held 1,171 pipeline, archive and flow records with 155,853,818 JSON
bytes. Each measured clone received the same prepared projection artifact; the
liveness template added one flow with 1,000 synthetic rounds.

| Operation | Transition | Before main-thread ms / bytes | After main-thread ms / bytes | Result |
| --- | --- | ---: | ---: | --- |
| Count refresh | One conversation-id update | 1,155.223 / 469,247,892 | 14.918 / 540,818 | 4,113 attempts in all pairs |
| Count refresh | One attempt crosses the 30-day window | 918.704 / 469,493,718 | 2.894 / 250,049 | 4,214 attempts in all pairs |
| Liveness | 1,000 confirmed-dead rounds | 4.999 / 143,927 | 1.000 / 149 on the repeated read | 1,000 PID probes before; none after; one targeted dead-owner proof retained |

The saved source corpus had no headless rounds, so the liveness template added
1,000 valid synthetic historical rounds with nonexistent PIDs. Legacy and
projected snapshots returned the same empty path result and the same targeted
dead-owner evidence. The first projected pass moved confirmed-dead rounds out
of the active walk; the next snapshot visited zero active rounds while one
indexed proof remained available for result assembly. Count result parity and
the exact boundary timestamp matched across every pair.
`scripts/measure-history-deltas.ts` records the procedure and writes one raw
measurement record per isolated process.

Cold projection preparation has a median elapsed time of 5,191.2 ms and median main-thread time of 4,138.3 ms. The first measured history request after preparation has a median elapsed time of 16.848 ms; warm calls have 0.640 ms median elapsed time and a maximum observed timer gap of 0.121 ms. Preparation is paid during Viewer startup.

The procedure uses byte-identical private SQLite backups for each mode and fresh
process. Three process pairs per operation each perform one cold request and
three warm requests. The history operation exercises the old pipeline/archive/
flow loads and curator counting loop, then their narrow count, lineage and
headless-owner readers plus the active-owner walk. The admission operation
compares the registry snapshot with one keyed conversation snapshot. All
corresponding result counts must agree.

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

The final touched-test gate completed 32 explicit files against
`e4a86ff27da40a747b801f8f20cfd175ca638668` through `scripts/gate-slot.sh`, with
isolated `HOME`, `XDG_CONFIG_HOME`, `LLV_STATE_DIR` and `TMPDIR`. It reported
zero new failures, eight pre-existing failures and one flaky classification.
Branch and baseline runs took 71.647 s and 15.613 s; flaky confirmation took
11.141 s. The typecheck passed through the same isolated wrapper. Exact paths
and outcomes are in the evidence JSON.

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
