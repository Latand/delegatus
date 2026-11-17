# Bounded delivery controller work

Progress persistence belongs to the accepted progress store. Its flush and retry
timer leave the caller's operation lease, while closing the store revokes its
timer. Dirty records and the completeness checkpoint remain owed until commit;
the prune clock advances only after commit. A persistence refusal schedules
only another persistence attempt.

Migration discovery reads indexed pages of open deliveries, active migrations,
successor cleanups and draining intents. Each collection contributes at most
64 rows per pass. Committed migrations have a separate repair cursor, so old
completions cannot crowd out active migration discovery. The elapsed budget
starts before discovery and also bounds waits for lanes, board repair and
intent completion. A lane that outlives the pass keeps its existing ownership.
Related board repairs remain grouped. One repair executor and a bounded cache
of 256 recent completions give late lanes prompt repair; durable repair markers
and the rotating history cursor cover eviction and process restart.

Cursors belong to one registry and its storage identity. Only visited rows
advance discovery. Restart replays discovery from the beginning and retains
the original durable delivery identities. Replacing the storage resets its
cursor. Intent completion checks current membership and phase under the writer
and commits the balance outcome with the intent ending.

The migration cycle requests delivery without awaiting the general queue's
lifetime. General delivery wakes share one executor and one owed wake. A drain
runs at most two passes before yielding further work to its existing retry
timer. Overlapping admission observers share a subsequent listing; an admission
arriving during that listing still gets another listing. Fresh recipient lanes
retain their independent dispatch path. Native reconciliation visits at most
eight hosts per pass using a rotating map iterator and keyed registry reads.

Settled delivery evidence stays in the existing archive and compatibility
storage for keyed recovery and idempotency. Periodic discovery excludes
delivered and failed records. Conversation actuation selects only assigned or
uncertain records before applying its 256-row bound, so held switch residue
cannot hide a later actionable send. The existing reaper owns bounded archive
moves; this change introduces no historical evidence expiry.

## Shared contracts

Registry admission, migration commits, delivery claims, outcome recording and
predecessor SQLite writers still produce the same rows. JSON normalization,
the current/archive mapping, alias resolution, original-key recovery and
terminal receipt readers retain their existing formats. The added page
selectors use current `registry_rows` keys, including compatibility copies of
archived rows; write-maintained indexes cover both older writers and archive
moves. Only controller discovery and held-drain consumers use the new open-row
selection. The legacy `pendingDeliveries` recovery contract remains available.
Progress notes, checkpoints and settlement still share one atomic flush.

## Offline measurements

The reusable entry point is
`src/lib/accounts/migration/peakLoad.fixture.ts`. Its recorded synthetic input
has 56 host entries, 22,538 conversations, 34,088 delivery rows, 34,088 operation
owners and 256 receipts: 91,026 rows and 371,090,935 payload bytes. It uses 128
uncertain open deliveries for stress. The production diagnosis observed eight
open deliveries; its diagnostic pending cap of 128 is a separate measurement.
Other production collections are deliberately reduced in this fixture.

Two separate processes each ran five sequential migration passes against the
same recorded rows. The baseline used the source at `a63693d9`; the candidate
used this change. Both used Bun 1.4.0, the same local gate wrapper, its default
heap and CPU placement, isolated state and no concurrent benchmark process.
Shared-machine contention was not held constant.
Each run fingerprinted every registry row before and after; all four row
fingerprints were identical. Schema/index installation is outside pass timing.
No actuation or registry-row mutation occurred in these measurements.

| Measurement | Baseline | Candidate |
| --- | ---: | ---: |
| Five pass times, ms | 3327.43, 1189.74, 1294.25, 1328.92, 1336.53 | 18.34, 4.87, 0.96, 4.32, 3.83 |
| Median pass, ms | 1328.92 | 4.32 |
| Maximum pass, ms | 3327.43 | 18.34 |
| RSS after five passes, MiB | 1963.89 | 213.40 |
| Native host reads per production-controller pass, 56-host test | 56 | at most 8 |

An earlier three-minute baseline CPU profile used the same census and recorded
61 passes. Recorded sample counts identify archived-row reconstruction,
registry accessors, enumeration, JSON parsing, filesystem identity probes and
freezing as major work. The retained profile and aggregate frame table provide
the attribution. They cannot reconstruct the historical production JS/GC split.
RSS here is a process endpoint observation. These results describe this offline
fixture and its idle reconciliation workload; production latency, recipient
acknowledgements and the files-response worker require release-owner validation.

## Regression coverage

Tests cover an actual refused progress transaction with prune due and an expired
lease, persistence retry, terminal journal evidence, exactly one engine write,
and a new executor process issuing zero further writes. A closed progress owner
cannot overwrite its successor. Other cases cover a zero-budget pass, large
settled history, two 64-row delivery pages across real process restarts, a held
independent queue wake, bounded repeated wakes, admissions during listing, and
56-host production-controller reconciliation. A separate page test uses 4,096
hosts. Existing coordinator tests retain board grouping, per-conversation order,
late provider results, rollback ownership and original-key recovery coverage.
