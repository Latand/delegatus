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

See [M4](main-thread-blocking-audit.md#m4-replays-on-scratch-copies).
The before run preceded implementation. Both sides use fresh copies of the
same read-only `VACUUM INTO` exports, made on 2026-10-18 at 18:49 UTC, with the
journal key copied privately. Production is only read. Every case runs in a
fresh process through the supplied CPU-admission gate, with private HOME,
XDG_CONFIG_HOME, TMPDIR, CODEX_HOME and LLV_STATE_DIR, and a Viewer URL on a
closed port. The copied journal has three qualifying pending effects. The
registry has 8,327 hot conversations, 7,183 hot entries and 7,491 hot receipts.
The before map includes 8,401 retention identities.

The measurement record is
[`evidence/perf/runtime-journal-maintenance.json`](../../evidence/perf/runtime-journal-maintenance.json).
It keeps every sample's UTC, load, wall time, CPU, loop delay, heap/RSS changes
and read counts, plus database and measured-source fingerprints. Each case
runs in two fresh processes per revision, each with one first run and five warm
runs. First runs are excluded from warm ranges.
Bun is 1.4.0, matching the Dockerfile. The runner has affinity to 24 CPUs and
no cgroup CPU quota. These are isolated replays; production gap changes require
a deployment and a subsequent observation window.

The one-minute load ranged from 3.38 to 6.21 before and 5.87 to 9.33 after.
First maintenance calls after the change took 269.09 and 371.86 ms; the 10 ms
acceptance bound applies to warm ticks.

| Case | Before warm median [range], ms | After warm median [range], ms |
| --- | --- | --- |
| `R2-maintenance` | 736.12 [708.48–817.39] | 4.50 [2.42–6.89] |
| `R2-map` | 714.98 [687.50–872.21] | 3.79 [2.01–4.93] |
| `R2-settle` | 0.43 [0.38–0.71] | 0.57 [0.37–0.77] |

The after `R2-map` measures the keyed evidence and reducer for the three
pending ids; the before case measures the full reducer over a prepared snapshot.
`R2-settle` on both sides measures settlement with a prepared lookup.
`R2-maintenance` measures the complete pending-selection/retention/settlement
body. Neither maintenance case includes the separate vacuum scheduling check.

### Reproduce the three cases

Export base `7ef6d95aa` and the candidate into separate scratch directories,
using the same frozen dependencies. Copy the registry, journal and journal key
once by M4's `prepare.sh`, then clone that seed for each case and revision.
Use the `probe.ts` timer and sampler from M4 with six runs. The before case
bodies are verbatim M4. Replace only the three after factories as follows:

- `R2-maintenance`: open the copied journal before timing, then time
  `maintainRuntimeJournal(journal, agentRegistry)` each run.
- `R2-map`: open the journal and registry before timing. Select distinct pending
  conversation ids with the SQL below; time a loop calling
  `registryConversationRetentionStates(registry.conversationRetentionSnapshot(id)).get(id)`.
- `R2-settle`: open the journal and prepare the selected states before timing.
  Build the lookup by calling `settleStalePendingEffects({ get(id) { ... } })`
  once, storing each targeted state in a map. Time
  `journal.settleStalePendingEffects(map)` thereafter. This preparatory pass
  mutates only the copy; no effect settles in this data on either side.

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

The pinned runtime-host rehearsal passed: succession completed in 505 ms; the
stable listener and runtime socket each answered 27/27 polls during a 15 s
hold, with 13 callers on each endpoint abandoning the response. This exercises
the runtime host. The focused tests cover pending-id equivalence, 70-hop aliases,
cycles, supersedence, receipt precedence, empty ticks, refused lookups, durable
absence recovery, peer changes, history-flat reads and operation/span evidence.

Required remote contexts remain `typecheck`, `privacy-publication`,
`privacy-tracker-audit` and `runtime-gate`. No push or remote CI run was made in
this stage. The tracker audit needs a published issue or PR surface; none is
created when the lane branch is absent from the remote.

Local verification completed with 174 passing tests across the five explicit
paths (including `src/runtime-host/journal.test.ts`), a clean full typecheck
and the pinned runtime-host rehearsal. Privacy publication is checked at
commit and again before stage completion.
