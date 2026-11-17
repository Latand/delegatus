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

JSON storage carries a generated `_jsonStoreId` in its header. Atomic commits,
normalization, snapshot copies and SQLite import/mirroring preserve that lineage.
JSON startup compaction or a JSON writer assigns it to legacy files; reads and
SQLite imports preserve an absent lineage. Discovery reads at most 128 header
bytes to distinguish an ordinary commit from a replaced store. Inode changes
alone never discard discovery, repair or intent ownership.

The migration cycle requests delivery without awaiting the general queue's
lifetime. Its request owner checks the current credit guard before scheduling
the wake. The cycle waits within its remaining budget; an unfinished guard
retains one owner and a shared acknowledgement with the earliest requested
deadline. General delivery wakes share one executor and one owed wake. A drain
runs at most two passes before yielding further work to its existing retry
timer. Overlapping admission observers share a subsequent listing; an admission
arriving during that listing still gets another listing. Fresh recipient lanes
retain their independent dispatch path. Native reconciliation visits at most
eight hosts per pass using a rotating map iterator and keyed registry reads.
Credit-guard host discovery also uses eight-host pages and requests continuation
through that owned wake. An unblocked account needs no host enumeration.

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

Writer claims seek assigned predecessors by recipient, generation and admission
sequence through a covering index. Legacy and tied admissions retain the existing
JavaScript comparison order. The transaction overlays its own assignments and
terminalizations before deciding. Readiness signatures use indexed state-existence
checks, so a successful claim also avoids decoding retained terminal history.
The JSON fallback retains the same admission decision over its in-memory file.

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

The `--observe` mode counts a complete observation sweep of all 128 open rows.
Both processes made exactly 640 observations over five sweeps, with the same
before/after row fingerprint. Actuation was disabled in both. The candidate
needed 2, 3, 3, 3 and 3 bounded passes, including cursor wrapping, to finish
those sweeps; the baseline used one unbounded pass per sweep.

| Equal-work observation measurement | Baseline | Candidate |
| --- | ---: | ---: |
| Five complete sweep times, ms | 7521.15, 3467.04, 3547.73, 3770.14, 3740.54 | 289.43, 299.11, 398.16, 438.63, 403.69 |
| Median complete sweep, ms | 3740.54 | 398.16 |
| Maximum individual pass, ms | 7521.14 | 271.56 |
| RSS after five complete sweeps, MiB | 1636.77 | 167.95 |

An earlier three-minute baseline CPU profile used the same census and recorded
61 passes. Recorded sample counts identify archived-row reconstruction,
registry accessors, enumeration, JSON parsing, filesystem identity probes and
freezing as major work. The retained profile and aggregate frame table provide
the attribution. They cannot reconstruct the historical production JS/GC split.
RSS here is a process endpoint observation. These results describe this offline
fixture and its observation-only reconciliation workload; production latency, recipient
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


## Review repairs

Open-delivery drains now keep a bounded keyset cursor per registry storage
identity and state set. Each state seeks the recipient/state/key compound
index before its limit; at most 768 keys are merged into a 256-row page.
Observation reads leave the drain cursor alone. A short page releases its
offset, and reopening or replacing the store restarts discovery. The existing
writer claim still compares every earlier assigned admission, preserving legacy
creation/id ordering and the original operation, recipient and generation.
An oldest admission outside the first storage page is reached on a later drain.

The cycle deadline also covers quota acknowledgements. One retained quota owner
per registry/port runs the three engine ticks outside the cycle lease; repeated
cycles join that owner until it settles. Its late failures remain observed, and
monitoring labels its lifetime as `controller.account-quota`. Cycle observers
detach at their deadline. A failure that already settled remains visible while
another quota or migration peer is held; late failures retain sanitized diagnostics.

Regression cases reverse both storage and admission order across 301 deliveries,
include legacy rows, interleave observations and reopen the registry after
settlement. Concentrated-history SQL coverage checks the actual plan and VM loop,
including empty results. An external parent watches positive-budget discovery
passes over 128 unchanged active admissions, then verifies one dispatch under
each original identity across executor processes. Separate mutation controls
remove positive elapsed expiry and discovery cursor advancement.


The earlier repair remeasurement (`71225add87` executable source) used two fresh processes over prebuilt copies of the
same recorded synthetic rows, with fixture construction excluded from both
processes. Five full sweeps again made 640 observations on each side and kept
matching before/after row fingerprints. Baseline remained `a63693d9`, with the
same installed dependency inputs and Bun 1.4.0. Shared-machine contention was
uncontrolled. The fresh median full-sweep times were **3443.60 ms before and
401.95 ms after**; endpoint RSS was **1629.70 MiB and 167.42 MiB**. These numbers
retain the offline workload limits above.

For the separate concentrated-history workload, the production SQL and actual
schema were also read by an independent SQLite 3.45.1 progress-handler counter.
Five observations over 32,768 terminal rows and one open row returned identical
results without changing any row. Steady VM work was **393,419 versus 64 steps**
for one match and **393,416 versus 58** after the open key, with no matches.
First-prepare overhead was separately visible (393,578 versus 74 steps).
The Bun regression checks its own query plan and loop bytecode; these counters
measure the independent interpreter, with its version stated explicitly.

The writer-claim repair was measured separately with five fresh copies per
fixture and matching input-row fingerprints. Restoring only the previous claim
guard decoded 1, 1,025 and 8,193 delivery payloads with 0, 1,024 and 8,192 retained
terminal rows; the repaired off-loop claim decoded exactly one in every sample.
This comparison retained the final readiness selectors on both sides. It measures
one real claim and excludes construction, schema installation and dispatch.
Focused tests also inspect the selector plan and VM loop, including empty
predecessor ranges. The idle-pass regression asserts decoded rows and absence of
whole snapshots; an external scheduling pause does not affect those assertions.
