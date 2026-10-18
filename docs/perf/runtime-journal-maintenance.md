# Runtime journal minute maintenance (L1)

This slice covers runtime-host maintenance. Profiler changes, other operation
labels, the pipeline archive and curator work remain with their own lanes.

The minute maintenance tick queries pending spawn/kill effects before reading
registry evidence. An empty query opens no registry. Each selected conversation
gets a keyed read transaction containing its forward alias chain, conversation,
newest generation entry and receipts selected through the reverse alias and
conversation-id indexes. The existing retention reducer runs over that small
snapshot. Its cycle handling, receipt precedence and alias fallback rules stay
shared with the full-map reference.

The lookup memo lasts one tick. A subsequent tick sees peer changes. Settlement
continues to require a continuous absence horizon and agreement with journal
host state. A failed registry read leaves the effect pending and preserves its
absence timestamp. Sends and interrupts keep their existing settlement rules.

## Shared surfaces

`RuntimeJournal.settleStalePendingEffects` accepts a `get` lookup. Existing map
callers (retention tests) remain compatible; `maintainRuntimeJournal` supplies
the lazy lookup in the runtime host. The pending SQL, journal transitions,
registry schema and registry writers are unchanged. The new registry accessor
uses `readKeyed`, `registryKeysMatching` and `registryRowsMatching`; it copies
selected evidence before the transaction closes. SQLite and JSON fallback
fixtures compare it against `registryConversationRetentionStates`.

`runtime-journal.maintenance` labels settlement under the loop monitor;
`runtime-journal.retention-map` records the synchronous reducer. Their shared
registries are `ViewerOperation` and `performanceSites`, read by the loop
monitor, span recorder and watchdog. Existing `registry.keyed` spans measure
the registry reads.

## Copied-state replay

See [M4](main-thread-blocking-audit.md#m4-replays-on-scratch-copies) for the
copy, isolation and sampler procedure. This final replay compares base
`7ef6d95aa` with candidate `55ee6ad99` on two fresh process copies per case and
revision. All twelve processes cloned the same immutable read-only
`VACUUM INTO` seed, copied on 2026-10-18 at 19:41 UTC; production was only
read. Each process ran one first sample and five warm samples through
`scripts/gate-slot.sh`, with private HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME,
TMPDIR, CODEX_HOME and LLV_STATE_DIR, and a Viewer URL on a closed port. Bun was
1.4.0 and the runner had affinity to 24 CPUs. The copied journal had three
qualifying pending effects. The full registry retention map had 8,415
identities; the selected states were current, current and dead. The final
keyed projection matched all three full-map states, reading and parsing 11
registry rows. Each maintenance and settlement result was `{ scanned: 3,
settled: 0 }`.

The measurement record is
[`evidence/perf/runtime-journal-maintenance.json`](../../evidence/perf/runtime-journal-maintenance.json).
It keeps each sample's UTC, load, wall time, CPU, 10 ms timer delay, heap/RSS
changes and read counts, plus database and measured-source fingerprints. The
timer gets a 20 ms event-loop turn after the measured call so it can record a
late callback; that wait stays outside the call's wall-time measurement. First
samples are excluded from warm ranges. Source fingerprints cover both
revisions and include `sqliteRegistryStore.ts`, which supplies the final
projection. These are isolated replays; production gap changes require a
deployment and a subsequent observation window.

The measured one-minute load ranged from 6.31 to 8.70. The 10 ms acceptance
bound applies to warm maintenance ticks. The final path's warm maintenance
range was 1.49–3.86 ms across ten samples.

| Case | Before warm median [range], ms | After warm median [range], ms | Load 1m, before / after |
| --- | ---: | ---: | ---: |
| `R2-maintenance` | 876.28 [805.85–1,306.43] | 2.11 [1.49–3.86] | 8.23–8.70 / 8.06–8.70 |
| `R2-map` | 775.06 [728.99–897.66] | 1.24 [1.12–2.21] | 7.32–8.29 / 7.13–7.93 |
| `R2-settle` | 0.38 [0.36–0.41] | 0.42 [0.36–0.57] | 6.31–6.88 / 6.31–6.65 |

The after `R2-map` measures the keyed evidence and reducer for the three
pending ids; the before case measures the full reducer over a prepared snapshot.
`R2-settle` on both sides measures settlement with a prepared lookup.
`R2-maintenance` measures the complete pending-selection/retention/settlement
body. Its before path builds the full retention map in the measured call; its
after path calls `maintainRuntimeJournal` with the keyed projection. Neither
maintenance case includes the separate vacuum scheduling check. Across the
two fresh processes, first maintenance calls were 1,286.49 and 1,440.18 ms
before, and 6.90 and 5.19 ms after; the warm limit is met independently of
those first calls.

### Reproduce the three cases

Export base `7ef6d95aa` and candidate `55ee6ad99` into separate scratch
directories, using the same frozen dependencies. Create one immutable seed by
read-only `VACUUM INTO` for the registry and journal and copy the journal key
with mode 0600. Clone those exact bytes for each case and each of two fresh
processes per revision. Use the `probe.ts` timer and sampler from M4 with six
runs per process. The R2 cases use these operations:

- `R2-maintenance`: open the copied journal before timing. Before, time
  `journal.settleStalePendingEffects(registryConversationRetentionStates(
  registry.readOnlySnapshot()))`; after, time
  `maintainRuntimeJournal(journal, () => registry)`.
- `R2-map`: open the journal and registry before timing. Select distinct pending
  conversation ids with the SQL below. Before, time the full reducer over the
  prepared snapshot; after, time the reducer over each keyed
  `conversationRetentionSnapshot(id)`.
- `R2-settle`: open the journal and prepare the selected states before timing.
  Build a map of just those ids from the full snapshot before and keyed
  projections after. Time `journal.settleStalePendingEffects(map)` thereafter.
  This pass mutates only the copy; no effect settles in this data on either
  side. Independently compare every keyed pending-id state with the full-map
  reference before accepting timing results.

```sql
SELECT DISTINCT operations.conversation_id AS id
FROM operations JOIN outbox ON outbox.id = 'effect:' || operations.operation_id
WHERE outbox.state = 'pending'
  AND outbox.kind IN ('runtime.spawn', 'runtime.kill')
  AND json_extract(operations.receipt_json, '$.status') IN ('pending', 'queued');
```

All maintenance and settlement samples must return `{ scanned: 3, settled: 0 }`.
The targeted map returns two current states and one dead state; compare each
pending id against the full map before accepting a timing result. An empty
journal must produce zero registry row reads. To reproduce the history guard,
run the two explicit test paths below; their child processes measure complete
ticks with 20 and 200 unrelated conversations, entries, receipts and aliases,
then repeat after reopening the real process.

## Verification

Run each heavy command separately through the supplied gate with isolated
HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR:

```sh
bun test src/runtime-host/journalRetention.test.ts src/lib/agent/registry.retentionRead.test.ts
bun test src/lib/performanceSpans.test.ts src/lib/viewerLoopMonitor.test.ts
bun scripts/verify-runtime-host.ts --runtime "$(command -v bun)"
NODE_OPTIONS=--max-old-space-size=6144 node node_modules/typescript/bin/tsc --noEmit --incremental false
bun run privacy:check
```

The pinned runtime-host rehearsal passed on candidate `55ee6ad99`: succession
completed in 504 ms; the
stable listener and runtime socket each answered 27/27 polls during a 15 s
hold, with 13 callers on each endpoint abandoning the response. This exercises
the runtime host. The focused tests cover pending-id equivalence, 70-hop aliases,
cycles, supersedence, receipt precedence, empty ticks, refused lookups, durable
absence recovery, peer changes, history-flat reads and operation/span evidence.

Required remote contexts remain `typecheck`, `privacy-publication`,
`privacy-tracker-audit` and `runtime-gate`. No remote CI run was made for this
evidence refresh. The tracker audit requires a published issue or PR surface.

At the final source revision, the preceding fix stage recorded 217 passing
tests across six explicit files, a clean full typecheck, privacy scan and ESLint
with one warning. This evidence refresh reran the full typecheck, privacy
publication gate and pinned runtime-host rehearsal. Privacy publication is
checked again after commit.
