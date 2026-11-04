# Attempt scratch retention

The investigation read the service journal without running retention against
live state. All removals used synthetic roots in isolated scratch exports.

## Incident and cause

The 24-hour window ending 2026-11-04 20:14 UTC contained 37 bare tick failures,
191 checkout-inventory budget failures, 114 bare `find` failures, and 757
completed sweep summaries. Summaries recorded 490 retired roots and
202,420,436,992 reclaimed bytes (8.43 decimal GB/hour).

The minute attempt request shares a leased helper with worktree and legacy
sweeps. Its 60-second deadline starts before queueing. A request that waited
behind a longer sweep therefore threw before running. The scheduler printed
only the exception name. The regression reproduces that causal path using the
real worker, an acknowledged held worktree request, and a controlled clock.
Thirty-one of the 37 historical failures have nearby loop telemetry showing
sweep waits above 60 seconds. The other six have narrower evidence: three
follow active attempt work and repeated inventory failures, while three
coincide with the preceding shared sweep finishing or failing. This supports
two deadline paths: queue expiry and active work repeating expensive checkout
observations. Historical exception payloads were discarded, so this causal
attribution is an inference from timing, the source and the reproductions;
the old log cannot supply the exact original exception text.

Production lane authority also constructed a fresh checkout inventory on every
recheck, bypassing the sweep inventory. The eight-root regression observes 48
native checkout walks on the base and one with shared inventory. A rejected
checkout read remained cached; recovery now evicts it immediately. Diagnostics
retain stderr, exit code, signal, and killed status. A checkout proven absent
since a process snapshot has no links to retain. Unreadable existing checkouts
continue to refuse retirement.

## Scheduling and report

Over cap, released roots supply three quarters of a bounded page, ordered by
oldest observation cohort and then largest recorded allocation. The remaining
quarter visits old observations, treating a release checkpoint of zero as the
root's creation time for fairness. Current lane authority ranks finished,
settled candidates first and largest first within that page. Every deletion
still rechecks authority, identity, process references, checkout links and
evidence. Failed observations checkpoint progress before awaiting I/O, so
restart and fresh arrivals do not reset the queue.

A 40-second run budget and the shared 30-second checkout inventory budget
produce deferrals. Reports distinguish deferred bytes, held live bytes, held
evidence bytes, other held bytes, failed bytes, and allocation outside the
current page. Per-root outcomes retain the reason. An absent root contributes
zero bytes while its custody can remain. A real pending quarantine keeps its
allocation projection until replay; a failed completion receipt keeps custody
with zero allocation after confirmed removal.

No ownership record, deletion journal, or report field used by an existing
consumer was removed. Scratch/config producers register through
`AttemptTempStore`; host settlement calls `release`. The production authority,
fixture helpers and recorded-check lifecycle call `sweepAttemptTemps`. The
leased worker validates `checked` and `removed`; disk pressure reads the
existing `bytes`, `liveHeldBytes` and `overCapBytes` fields. Added report fields
are additive. The ledger schema is unchanged.

## Capacity estimate

These are estimates, conditional on eligible roots being available. A 107.4 GB
scratch cap leaves about 192.6 GB for permanent data and all other protected
allocations within a 300 GB disk-use target. The cap alone cannot enforce the
total-disk target or reclaim valid live/evidence holds.

If the observed 120 GB/day is **net growth**, the observed 8.43 GB/hour reclaim
rate implies about 13.43 GB/hour of gross additions. Reclamation must exceed
that rate to reduce usage. If 120 GB/day instead describes gross additions,
the break-even rate is 5 GB/hour. Clearing the reported 480.5 GB excess takes
`480.5 / (reclaim GB/hour - gross additions GB/hour)` hours at a stable rate.
A production throughput gain requires measurement after deployment.

## Verification

The committed tests drive the real sweep and production authority. The
comparison fixture contains 727 registered roots, 32 roots with 16 MiB data,
1,024 checkout links, two owned CPU workers and one synced 1 MiB disk writer.
Base and head alternate over three rounds with fresh state, HOME, config and
temp directories. Host load is sampled around each run. The native process
and container inventories are excluded from this throughput comparison;
separate safety cases exercise those guards.

`comparison.json` records the intermediate snapshot: median base/head duration
8.31/2.53 seconds, maximum 8.63/14.21 seconds, 192 base checkout walks and
1/1/2 head walks. Every measured run removed 32 roots and 537,133,056 bytes.
At a one-minute cadence, both revisions model 32.23 GB/hour. The measured
cadence throughput is unchanged; checkout observation cost is lower. The
slowest head sample coincided with a recorded load spike to 38.3.

At 32.23 GB/hour, clearing the reported 480.5 GB scratch excess against an
estimated 13.43 GB/hour gross addition rate takes approximately 26 hours.
This is a fixture-based estimate. Production reclaim throughput and the total
300 GB target remain conditional on eligible allocations and other retention
owners.

Verification is incomplete. The five touched test files passed in isolated
exports, followed by updated retention tests and 14 induced-fault controls.
The subsequent recorded campaign was refused by the native waiter with
"Check result unknown: gate log is outside this stage's temporary root."
Its original run and evidence were preserved and were not restarted. The
final completion-receipt and quarantine accounting changes require a fresh
verification attempt; the 30-round queue campaign and final lint have no
accepted terminal verdict. The comparison and mutation files explicitly name
their intermediate source snapshot. The benchmark is an opt-in case in
`src/lib/runtime/attemptTempProduction.test.ts` selected by
`LLV_ATTEMPT_TEMP_BENCHMARK=1`. Its load mode reuses
`src/lib/runtime/attemptTempRetention.fixture.ts`. No standalone driver is
added to the repository.
