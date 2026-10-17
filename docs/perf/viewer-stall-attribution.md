# Viewer stall attribution

This change adds attribution for the next isolated replay or approved release.
The production caller behind the reported fourteen-second stalls remains
unobserved. No production fix, GC attribution or deployment improvement is
claimed.

## Independent heartbeat evidence

`loopWatchdog.ts` keeps the existing 600-slot, 100 ms shared ring. The main
monitor updates one atomic heartbeat on each tick. The independently scheduled
worker records a trigger when that heartbeat is more than one second old.
The trigger contains numeric timestamps and the current static performance-site
number. It records one trigger per stale heartbeat, with a sixty-second
cooldown and one retained record. The whole shared allocation is 43,272 bytes.
There is no message stream, stack capture, profiler, filesystem output, or
main-thread read added to an ordinary monitor tick.

The next loop-gap report includes the retained trigger under `scheduler.stall`,
with its site decoded. Its timestamp belongs to the stalled interval, before
the recovery callback. The sequence repeats until a later trigger replaces it;
compare its timestamps with the gap before attributing that gap. A static site
describes an enclosing synchronous call. It does not identify a native or GC
stack. Unwrapped work remains `unknown-runtime-or-native`.

Tests run a real worker across main-thread CPU blocks, delay observation past
recovery, start fresh processes, probe cooldown, and run the actual producer
past 600 samples. The healthy-heartbeat control retains no trigger. The
unpublished trigger sentinel is rejected by the reader.

## Phase inventory

| Producer | Phase | Consumer |
| --- | --- | --- |
| Scanner worker stdout consumer | `scanner.ipc-frame`, `scanner.ipc-decode` | Shared performance spans and watchdog site |
| Resource and completed catalog publication | `scanner.publication` | Same recorder; existing catalog generation fence |
| Completed catalog to index feed | `transcript.feed` | Same recorder; existing index scheduler |
| Persisted scan snapshot writer | `scanner.cache-encode`, `scanner.cache-persist` | Same recorder; existing persistence path |
| Transcript feed background runner | `transcript.index` | Awaited span plus loop-monitor operation |
| Memory service discovery and refresh | `memory.discovery`, `memory.refresh` | Awaited spans plus loop-monitor operations |
| Memory parse, database initialization and entry transaction | `memory.refresh` | Synchronous spans and watchdog site |

The site array is append-only in this change, preserving existing numeric IDs.
The worker produces the shared numeric ring; `startLoopWatchdog().snapshot()`
reads it; `createViewerLoopMonitor` consumes it and maps sites in journal JSON.
The standalone `benchmark-loop-heap.ts` and performance-span tests also read
the ring. Journal consumers in the read-attribution and registry benchmarks,
SQLite tests and pipeline responsiveness/lease tests select existing fields;
none requires an exact set of scheduler keys.
Runtime-host consumers of the same monitor retain the same report shape with
one additive field. Payloads, catalog fences, durable formats, refresh cadence
and failure outcomes retain their existing contracts.

The open residual-reader change owns scanner discovery and registry readers.
Its diff was checked; this change leaves those implementations alone.

## Pinned-runtime profiler control

Run `scripts/probe-loop-profiler.ts` through `scripts/gate-slot.sh`, with private
HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR. The script creates another
private child environment. An outer parent owns a fifteen-second SIGKILL
deadline. Profiles exist only inside that disposable child; its output is
bounded control metadata without source paths or captured application data.

Under Bun 1.4.0, local `node:inspector` Profiler enable, 10,000 microsecond
sampling, start and stop identify both `namedMainThreadControl` and
`pbkdf2Sync`. An immediate second capture verifies that the previous caller is
cleared. A separate worker arms through `connectToMainThread()` and completes
its own stop before main-thread recovery, but misses the named main-thread
control which the local session captured. Successful command acknowledgement
does not establish that it targeted the main thread.

The pinned implementation's
[connectToMainThread](https://github.com/oven-sh/bun/blob/bun-v1.4.0/src/js/node/inspector.ts)
connects the worker's local session. Its
[CPU-profiler binding](https://github.com/oven-sh/bun/blob/bun-v1.4.0/src/jsc/bindings/BunCPUProfiler.cpp)
uses the calling VM and exposes sampling interval, start, and stop. There is no
producer sample cap in the exposed inspector path. The probe asks for a
one-sample cap with `maxSamples` and `maxBufferSize`; the returned profile
contains more than one sample. Truncating that result would only bound the
consumer after native samples and their conversion had already accumulated.

The probe performs real forced collections in another capture. Automatic-GC
coverage stays `unknown`; neither an allocation loop nor a function named `gc`
establishes coverage of automatic collections. The existing GC observer
continues to report `gc-entry-unsupported` on this runtime.

Consequently this change deliberately ships no continuous serving profiler.
A main-thread stop timer would run after a blocking call returns. The tested
worker session does not supply an independent main-thread stop or producer
cap. A bounded production recorder still needs a runtime primitive with those
properties, or separately authorized native sampling with an independently
controlled bounded producer. The diagnostic implementation remains partial
until that choice is resolved. Server-render and unlabelled native attribution
also remain open.

## Populated scanner replay

`scripts/measure-scanner-ipc.ts` replays 30,000 deterministic catalog rows as
4 KiB writes from a real leased scanner child. It emits the frame's SHA-256,
size, three timing samples, maximum timer gap, and sampled function names.
Run with `NODE_ENV=test`, the isolated roots above, and `gate-slot.sh`. Use
the same script and data for both revisions, in separate scratch exports;
do not time a serving installation. These are instrumented replay timings,
including process startup, with a 10 ms CPU sampling interval.

The final comparison used a 20,197,884-byte frame, SHA-256
`33daf4eb29d28fdfd2651f001adb04e8d3ea91a6bd49843f4c9c6e953020a06c`,
Bun 1.4.0, the same script in separate scratch exports, and the same gate
admission policy. The base was `225c3c166f710a6723ffa3309f0437d2f732df3c`.
Runs were serial, three at the base followed by three with attribution.

| Run | Base elapsed (ms) | Attribution elapsed (ms) | Base max timer gap (ms) | Attribution max timer gap (ms) |
| --- | ---: | ---: | ---: | ---: |
| 1 | 252.7 | 342.3 | 190.0 | 278.8 |
| 2 | 323.7 | 346.0 | 252.7 | 276.5 |
| 3 | 334.9 | 339.2 | 267.4 | 275.7 |

`consume` and `indexOf` dominated the base samples. Median elapsed time was
323.7 ms at the base and 342.3 ms with attribution, an observed increase of
18.6 ms (5.8%). These instrumented sequential runs do not isolate telemetry
overhead from scheduling variation. Neither revision reproduced the
fourteen-second stall. This change claims no speed improvement.

## Verification on 2026-10-17

Both the starting revision and this change built successfully. With the
repository's `createGateSandbox` and `isolatedEnvironment`, the Viewer
runtime verifier loaded 25/25 modules and served HTTP 200 on both builds.
Runtime-host succession passed, including 27/27 stable-listener responses
and 27/27 runtime-socket responses over fifteen seconds. The three executable
runtime negative controls passed. Typecheck and changed-file ESLint passed.

The watchdog/profiler/monitor group passed five tests. The scanner/memory
group passed 75 tests and retained one existing failure:
`worker scans publish a Claude transcript that appears in a previously
sessionless project directory`, with `read ECONNRESET`. The starting revision
failed the same case under the same isolation (10 pass, one fail). Both new
scanner diagnostic cases passed. The performance/heap/feed group passed
25 tests. An earlier 39-case run also covered catalog freshness successfully.

Initial Viewer runtime checks failed identically on both revisions because
their nested private inbox paths lost the pipeline scratch exemption. The
existing gate isolator resolved that harness condition; no owner token or
state-ownership exception was added. Test/build commands ran through the
project's gate wrapper, against scratch exports and private state.

The native shared-runtime selection and both pinned Codex engine selections
(0.154.0 and 0.159.0) passed. Detailed results are recorded in
[`viewer-stall-attribution.json`](../../evidence/performance/viewer-stall-attribution.json).
Hosted publication and tracker
audit checks belong to the pipeline's later publication; no source was pushed
or service deployed by this stage.

An own-process `perf stat -e task-clock -- true` control was refused at
`perf_event_paranoid=4`. The remaining recorder choice is a Bun primitive with
producer caps and independent main-thread stop, or separately authorized
native sampling. A native route first needs isolated producer/retention/output
bound tests and real JS/native/GC controls. Linux documents
[CAP_PERFMON as the specific profiling capability](https://www.kernel.org/doc/html/latest/admin-guide/perf-security.html).
No capability, kernel policy or service configuration was changed here.

## Deployment acceptance remains pending

After a separately approved deployment, record serving readiness, loaded
agent count, PID/start identity, revision and exact UTC START. END must be
exactly thirty minutes later. Select that closed interval with:

```sh
journalctl --user -u delegatus.service --utc --since "$START" --until "$END" \
  --all -o cat --no-pager | grep -aF '[viewer loop-gap] '
```

Parse JSON after the marker, select the serving Viewer identity and count
`gapMs > 5000`. Require zero, continuous performance-summary coverage,
stable serving identity, no lost gap sequence and no increase in `logDropped`.
An empty selection alone cannot pass. A populated isolated replay does not
replace this production acceptance window.
