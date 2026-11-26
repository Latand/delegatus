# Seat tick read costs and timing records

Read `timing` on the existing seat tick journal rows to follow a check. Each
check has a unique `checkId`, UTC `startedAt`, elapsed milliseconds, CPU
microseconds, and phase begin/end offsets. `files.<request>.queue` ends when
dispatch starts; `files.<request>.service` covers dispatch and response reading.
A queued request that expires records its wait and never starts service.

The journal stores phase names once per row and numeric tuples
`[nameIndex, beginMs, endMs, cpuUs, pending?]`. `readSeatTickRecords` expands these
to named objects, accepts older rows, and bounds malformed timing input.
`pending` marks work still outstanding at capture, including canceled sources
that cannot stop their I/O. CPU is **Viewer process CPU over the interval**:
concurrent work and worker threads in that process can contribute. Nested spans
overlap. These counters do not attribute CPU exclusively to one asynchronous
phase or measure the files-response child process's CPU.

After the 512-span bound, the journal keeps the newest 512 spans and increments
`dropped` for each evicted older span. The rolling buffer replaces one slot per
new phase, so its cost stays constant after reaching the bound. The final row is
captured after the check scope closes and is
durable before the check returns. Audit persistence and subsequent check-error
card bookkeeping are outside the recorded phase interval. The check awaits the
asynchronous journal writer under the existing file-transaction lock; lock
admission is bounded to one second. Retention examines bytes without decoding
saved phase payloads on the main thread. Both the global and each project's
existing rings retain 500 rows. A check retains at most 512 spans and reports
`dropped` beyond that limit. No persistent timing cache or per-phase timer was
added. The 75-second check budget is unchanged.

## Paired measurements

The measurements in `measurements.json` ran on 2026-11-05 under Bun 1.4.0 against
base `6e8b65d9` and the production source hashes captured for that replay. Those
hashes identify the measured source revision; the `sourceSha256` records in the
measurement files preserve those replay inputs. Current file hashes are in
`verification.json`. The release-demotion fence was added after the replay;
reported measurements assign no performance gain to that change. The paired
fixture was identical across both revisions (`fixtureHash` in each row). They exercise
Viewer modules in isolated Bun processes. They start neither a Viewer listener
nor a runtime-host listener. Worker regression tests separately exercise the
real files-response child process. This lane performed no production comparison.

Every registry run imports the same fixture bytes, identified by SHA-256, into
a fresh SQLite store: 12,000 delivery rows with 1 KiB retained text and 30
conversations. A production delivery builder supplies the seed shape. The
delivery probe calls `defaultSeatTickSources().withdrawWake` on an already
delivered row, returning `too-late` without a write. Both versions return that
same answer. Cold means a fresh registry reader; the OS page cache was not
flushed. Warm results are medians of five subsequent reads.

The curation probe uses 30 synthetic designated seats with fresh delivered wake
stamps, real host admission and SQLite status reads, and a liveness adapter
returning only the test process. All projects are quiet, so selection has no
launch effects. Warm results are medians of three sweeps. Each base sweep calls
the existing controller from every project; head shares one sweep owner. This
measures candidate admission: a due launch still performs its final host and
authority checks. The due-project regression separately proves launch.

Pairs ran base/head, head/base, base/head, sequentially with no added request
load. End-of-run one-minute machine load ranged from 26.1 to 35.3, so wall times
are subject to shared-machine noise. Main-thread CPU below uses
`process.threadCpuUsage`; the JSON also preserves process CPU and load.

| Pair | Cold lookup wall, base → head (ms) | Warm lookup median, base → head (ms) | Warm sweep median, base → head (ms) | Warm sweep main-thread CPU median, base → head (ms) |
| --- | ---: | ---: | ---: | ---: |
| 1 | 551.2 → 10.1 | 1.44 → 1.19 | 981.4 → 48.1 | 963.2 → 47.7 |
| 2 | 664.1 → 14.1 | 1.74 → 2.10 | 1370.0 → 61.2 | 1281.3 → 60.3 |
| 3 | 781.9 → 13.4 | 2.28 → 2.22 | 1296.2 → 75.8 | 1246.1 → 72.9 |

Candidate admissions are **900 → 30** in every sweep. Cold lookup savings are
541–769 ms, or 0.72–1.03% of one 75-second budget per lookup. This small fixture
shows no consistent warm lookup gain: pair two regressed by 0.36 ms.
Warm sweep savings are 933–1309 ms, equivalent to 1.24–1.75% of one 75-second
budget for the entire 30-project sweep. That aggregate is not a per-project
budget saving. The earlier copy-of-state investigation reported 262–266 ms
per warm lookup, about 0.35% of 75 seconds, on different data.

The production frequency of the held-delivery branch, phase overlap, large
registry refreshes and unrelated main-thread work remain unknown. These replays
do not explain the historical 75-second failures or establish that ticks are
fixed. Production comparison belongs after deployment.

## Timing cost

The overhead probe primes both journal rings to 500 rows and uses the actual
writers: the base writer without timings and the new asynchronous writer with
timings. Six alternating order trials each append 20 rows; tracing is measured
over 1000 constructions. Reported CPU uses the main thread, excluding filesystem
worker threads. Wall time includes awaited file I/O.

| Phases | Added bytes per row | Trace main CPU (ms/check) | Base journal main CPU (ms/append) | New journal main CPU (ms/append) | New awaited wall (ms/append) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 | 1979 | 0.112 | 0.96–1.67 | 1.44–1.89 | 7.85–10.01 |
| 512 | 9298 | 0.459 | 1.23–1.68 | 3.47–3.67 | 17.38–21.59 |

At the supplied observation's 179 checks per 41 minutes, the largest paired
main-thread increase plus tracing extrapolates to about 0.21 ms of CPU per
second, about 0.02% of one core. This extrapolation uses isolated burst
measurements; production main-loop impact remains unmeasured. File I/O is awaited
asynchronously. The early synchronous timing prototype was rejected after its
full-ring overhead was measured; it is not the shipped writer.

### Alarm reader follow-up

After review, alarm reconciliation stopped expanding stored timing rows. The
follow-up pair in `alarm-read-followup.json` uses the actual asynchronous writer
before each alarm read, with identical 500-row global and project rings and 512
phases in every row. Five alternating-order trials of ten check cycles compare
the former full reader with the alarm-only reader in one isolated Bun 1.4.0
process; both feed the same error-alarm projection. The fixture hash is
`9f26cc4532b77d7634c40781b9c0f7876ea5c079e3b7eeefaac362763809a56b`.

Median main-thread CPU fell from 29.86 ms to 16.40 ms per write plus alarm read
(45%); median awaited wall time fell from 39.64 ms to 25.55 ms (36%). This is
the upper-bound full-ring fixture, not a normal check's measured history size.
It removes about 13.5 ms of main-thread work from this fixture. It does not
explain the historical 75-second overruns or establish that ticks are fixed.

## Regression evidence

Tests cover recipient isolation, both alias directions, exact keys, N candidate
admissions, all-project wake-state coordination, fresh owed-check ownership,
next-sweep freshness, and a due project after a disabled project. The follow-up
late-eligibility and owed-check regressions pass on the final source and fail on
the pre-fix implementation. Existing curator admission tests retain
their settings, seat, host, deployment, ownership, deferred-launch and restart
fences. Timing tests cover precise boundaries and CPU deltas, failures, capped
records, compact encoding, old journals, concurrent writes, retention, writer
failure, and a fresh reader process. The queue driver holds a real child and
proves 17 ms of wait followed by 23 ms of service with a controlled clock.

The shared-owner regression fails on the pre-fix branch source by launching
once after release demotion; the final source passes it with zero launches.
The shared-owner-count regression fails on base with three reconciliations
instead of one. The two original withdrawal contention tests pass on base; their
head fixtures now prepare the indexes used in production and carry the actual
delivery recipient. Independent production mutations fail for the full-read
path, recipient filter, alias handling, message key, shared selection, due
launch, controller ownership, span cap, CPU delta, queue boundary and journal
reader. Mutations were confined to scratch exports and restored after each run.

The predecessor's post-review-fence results and source hashes are in
`verification.json`; they describe PR #3692 before the successor's shared
recovery cancellation fix. Its verification commands used `bun run test <explicit-file>`
individually with a fresh isolated environment, log and exit status. Its whole-project typecheck used
`bash scripts/gate-slot.sh bun node_modules/typescript/bin/tsc --noEmit
--incremental false` as a background job. Its local publication privacy gate
checked staged changes before the plain commit. The pipeline owns publication.
