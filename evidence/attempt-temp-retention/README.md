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

`comparison.json` records an earlier intermediate snapshot and remains
unchanged. The later six-run alternating comparison used the same 727 roots,
1,024 checkout links, two CPU workers and one synced 1 MiB writer. Each run
removed 32 roots and 537,133,056 bytes. Median base/head sweep durations were
7.39/5.60 seconds; checkout walks were 192/1. Load1 at run boundaries ranged
from 12.6 to 14.08. These are fixture measurements, not production throughput.

The hourly model includes both sweep duration and the scheduler's following
minute wait: `removedBytes * 3600 / (60 + elapsedSeconds)`. That yields about
28.70 GB/hour for base and 29.48 GB/hour for head under this fixture. It assumes
continuous eligibility, no queue wait and no extra pressure-triggered sweeps.
With inferred gross additions near 13.43 GB/hour, the measured head fixture
rate implies about 30 hours to reclaim the reported 480.5 GB excess. This is a
conditional estimate; production reclaim throughput was not measured. The
107.4 GB cap leaves about 192.6 GB for permanent data and other protected
allocations within a 300 GB target, so the cap and this reclaim estimate alone
do not guarantee that target.

Recovery verification completed on the committed retention source, with a
fixture-only correction in `attemptTempProduction.test.ts`. Each of the five
touched files ran directly as its own isolated command under Bun 1.4.0, using
the repository's owned test runner. All final file runs passed: retention 57,
filesystem 16, production 15, worker 34, and temp sweep 79 (201 total). The
filesystem file skipped 14 opt-in container cases; the production file skipped
its opt-in benchmark. `verification.json` records commands, source hashes,
counts, log hashes and actual exit statuses. Raw logs remain in retained
pipeline evidence. Changed-file ESLint and the local privacy publication gate
also passed. No live retention sweep ran.

The first production-file run hit host container churn: a container disappeared
between `docker ps` and `docker inspect`, correctly retaining the test root.
A controlled disappearing-container reply reproduced the assertion on the base.
The production fixtures now pass a fixed empty container observation through
the existing reference-check seam while keeping the real process and checkout
guards. The full file passes with the failing Docker reply still installed.
Container guard tests remain in `attemptTempFilesystem.test.ts`.

The review-round-three follow-up replaces checkout enumeration with a directory
walk that compares each directory's identity, mtime and ctime around its entry
read. A concurrent entry change defers that root, so an incomplete negative
link snapshot cannot be cached. The filesystem regression inserts a checkout
link between `readdir` and metadata capture; it verifies the read is refused
and the next complete read retains the linked root. New subprocess regressions
also exhaust the run and checkout-inventory budgets independently, exit the
helper, then resume against the same ledger and verify remaining bytes and
progress. Mutation controls independently removed the directory-change guard,
the inventory deadline and the run-budget guards; each named regression
failed. Final isolated file runs on the updated sources passed: filesystem 18
passed/14 opt-in skips, retention 59 passed, and production 17 passed/1
opt-in skip. The hourly model now includes the sweep duration before the
scheduler's next minute wait. No live sweep ran.

Two additional fault controls independently removed completion-receipt and
pending-quarantine accounting. Both failed their named regression assertions;
the original source was restored. The previous check's refused waiter remains
unadopted. Its recorder metadata has no accepted terminal verdict. Earlier
comparison and mutation records remain unchanged, with their original source
qualification; the recovery checks verify the final accounting separately.
The benchmark remains an opt-in case in
`src/lib/runtime/attemptTempProduction.test.ts` selected by
`LLV_ATTEMPT_TEMP_BENCHMARK=1`. Its load mode reuses
`src/lib/runtime/attemptTempRetention.fixture.ts`.
