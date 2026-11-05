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

The final row is captured after the check scope closes and is
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
base `6e8b65d9` and the listed final production source hashes. They exercise
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
load. End-of-run one-minute machine load ranged from 18.3 to 44.1, so wall times
are subject to shared-machine noise. Main-thread CPU below uses
`process.threadCpuUsage`; the JSON also preserves process CPU and load.

| Pair | Cold lookup wall, base → head (ms) | Warm lookup wall (ms) | Warm sweep wall (ms) | Warm sweep main-thread CPU (ms) |
| --- | ---: | ---: | ---: | ---: |
| 1 | 889.9 → 11.8 | 2.73 → 1.97 | 1691.6 → 40.6 | 1525.6 → 39.8 |
| 2 | 918.2 → 7.1 | 3.29 → 1.14 | 1670.9 → 53.1 | 1647.4 → 53.2 |
| 3 | 684.7 → 15.0 | 1.41 → 2.29 | 768.1 → 45.5 | 767.8 → 45.6 |

Candidate admissions are **900 → 30** in every sweep. Cold lookup savings are
670–911 ms, or 0.89–1.21% of one 75-second budget per lookup. This small fixture
shows no consistent warm lookup gain: the third pair regressed by 0.88 ms.
Warm sweep savings are 723–1651 ms, equivalent to 0.96–2.20% of one 75-second
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
| 100 | 1968 | 0.121 | 0.85–1.49 | 1.34–1.75 | 9.28–10.49 |
| 512 | 9297 | 0.589 | 0.88–1.20 | 2.50–3.27 | 12.94–16.29 |

At the supplied observation's 179 checks per 41 minutes, the largest paired
main-thread increase plus tracing extrapolates to about 0.20 ms of CPU per
second, below 0.03% of one core. This extrapolation uses isolated burst
measurements; production main-loop impact remains unmeasured. File I/O is awaited
asynchronously. The early synchronous timing prototype was rejected after its
full-ring overhead was measured; it is not the shipped writer.

## Regression evidence

Tests cover recipient isolation, both alias directions, exact keys, N candidate
admissions, concurrent and settled choice sharing, next-sweep freshness, and a
due project after a disabled project. Existing curator admission tests retain
their settings, seat, host, deployment, ownership, deferred-launch and restart
fences. Timing tests cover precise boundaries and CPU deltas, failures, capped
records, compact encoding, old journals, concurrent writes, retention, writer
failure, and a fresh reader process. The queue driver holds a real child and
proves 17 ms of wait followed by 23 ms of service with a controlled clock.

The shared-owner regression fails on base with three reconciliations instead
of one. The two original withdrawal contention tests pass on base; their head
fixtures now prepare the indexes used in production and carry the actual
delivery recipient. Independent production mutations fail for the full-read
path, recipient filter, alias handling, message key, shared selection, due
launch, controller ownership, span cap, CPU delta, queue boundary and journal
reader. Mutations were confined to scratch exports and restored after each run.

Verification commands use `bun run test <explicit-file>` individually with a
fresh isolated environment, log and exit status. Whole-project types use
`bash scripts/gate-slot.sh bun node_modules/typescript/bin/tsc --noEmit
--incremental false` as a background job. The local publication privacy gate
checks the staged changes before the plain commit. The pipeline owns publication.
